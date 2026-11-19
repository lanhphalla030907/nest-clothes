import crypto from 'node:crypto';
import { Injectable, UnauthorizedException, ConflictException } from '@nestjs/common';
import type { Prisma, RefreshSession } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ACTIVE_USER_STATUS } from '../../common/constants/user-status.constants.js';
import { RefreshSessionRepository } from './refresh-session.repository.js';
import {
  REFRESH_SESSION_TTL_MS,
  REFRESH_TOKEN_BYTES,
  REFRESH_CSRF_BYTES,
  REFRESH_RESULT_TTL_MS,
} from './refresh-token.constants.js';
import {
  RefreshResultEncryptionService,
  type RotationPayload,
} from './refresh-result-encryption.service.js';
import { AccessTokenService } from '../jwt/access-token.service.js';
import { Role } from '../../generated/prisma/enums.js';

export interface IssuedRefreshSession {
  rawRefreshToken: string;
  rawCsrfToken: string;
  session: RefreshSession;
}

export interface RotatedRefreshSession {
  rawRefreshToken: string;
  rawCsrfToken: string;
  accessToken: string;
  expiresIn: string;
  session: RefreshSession;
  userId: string;
}

const INVALID_REFRESH_MESSAGE = 'Invalid refresh session';

@Injectable()
export class RefreshTokenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: RefreshSessionRepository,
    private readonly encryption: RefreshResultEncryptionService,
    private readonly accessTokens: AccessTokenService,
  ) {}

  hashToken(rawToken: string): string {
    return crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
  }

  /**
   * Verifies the presented CSRF token against the session selected by the exact
   * refresh token in the request. Unknown, revoked or expired sessions are left
   * to the existing rotation/logout classification so reuse detection and
   * idempotent replay are unchanged.
   */
  async csrfBindingMatches(
    rawRefreshToken: string,
    rawCsrfToken: string,
    now = new Date(),
  ): Promise<boolean> {
    const session = await this.sessions.findByTokenHash(this.hashToken(rawRefreshToken));
    if (
      session === null ||
      session.revokedAt !== null ||
      session.expiresAt.getTime() <= now.getTime()
    ) {
      return true;
    }

    const expected = Buffer.from(session.csrfHash ?? '', 'hex');
    const actual = Buffer.from(this.hashToken(rawCsrfToken), 'hex');
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }

  hashOperationKey(operationKey: string): string {
    return this.validateAndHashOperationKey(operationKey);
  }

  generateToken(): string {
    return crypto.randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
  }

  generateCsrfToken(): string {
    return crypto.randomBytes(REFRESH_CSRF_BYTES).toString('base64url');
  }

  async createSession(
    userId: string,
    now = new Date(),
  ): Promise<IssuedRefreshSession> {
    const rawRefreshToken = this.generateToken();
    const rawCsrfToken = this.generateCsrfToken();
    const familyId = crypto.randomUUID();
    const expiresAt = new Date(now.getTime() + REFRESH_SESSION_TTL_MS);

    const session = await this.sessions.create({
      user: { connect: { id: userId } },
      familyId,
      tokenHash: this.hashToken(rawRefreshToken),
      csrfHash: this.hashToken(rawCsrfToken),
      expiresAt,
    });

    return { rawRefreshToken, rawCsrfToken, session };
  }

  async rotate(
    rawRefreshToken: string,
    operationKey: string,
    now = new Date(),
  ): Promise<RotatedRefreshSession> {
    const operationKeyHash = this.validateAndHashOperationKey(operationKey);
    const tokenHash = this.hashToken(rawRefreshToken);

    const maxRetries = 3;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        const outcome = await this.prisma.$transaction(
          async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '2s'`;
        await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;

        await this.sessions.acquireOperationKeyLock(operationKeyHash, tx);

        const existing = await this.sessions.findByTokenHashForUpdate(tokenHash, tx);
        if (existing === null) {
          throw new UnauthorizedException(INVALID_REFRESH_MESSAGE);
        }
        if (existing.revokedAt !== null) {
          await this.sessions.revokeFamily(existing.familyId, now, 'reuse', tx);
          return { reuseFamilyId: existing.familyId, reuseReason: 'reuse' };
        }
        if (existing.expiresAt.getTime() <= now.getTime()) {
          await this.sessions.revokeFamily(existing.familyId, now, 'expired', tx);
          return { reuseFamilyId: existing.familyId, reuseReason: 'expired' };
        }

        const user = await tx.user.findUnique({ where: { id: existing.userId } });
        if (user === null || user.status !== ACTIVE_USER_STATUS) {
          await this.sessions.revokeFamily(existing.familyId, now, 'account_inactive', tx);
          return {
            reuseFamilyId: existing.familyId,
            reuseReason: 'account_inactive',
          };
        }

        const tombstone = await this.sessions.findTombstoneForUpdate(
          operationKeyHash,
          tx,
        );
        if (tombstone !== null) {
          const matchesOldBinding =
            tombstone.oldRefreshSessionId === existing.id &&
            tombstone.oldTokenHash === tokenHash &&
            tombstone.familyId === existing.familyId &&
            tombstone.userId === existing.userId;
          const matchesReplacementBinding =
            tombstone.replacementTokenHash !== null &&
            tombstone.replacementTokenHash === tokenHash &&
            tombstone.familyId === existing.familyId &&
            tombstone.userId === existing.userId &&
            tombstone.oldRefreshSessionId !== existing.id;

          if (matchesOldBinding) {
            throw new UnauthorizedException({
              code: 'REFRESH_OPERATION_EXPIRED',
              message: INVALID_REFRESH_MESSAGE,
            });
          }
          if (matchesReplacementBinding) {
            throw new UnauthorizedException({
              code: 'REFRESH_REPLAY_STALE',
              message: INVALID_REFRESH_MESSAGE,
            });
          }
          await this.sessions.revokeFamily(
            existing.familyId,
            now,
            'operation_binding_mismatch',
            tx,
          );
          return {
            reuseFamilyId: existing.familyId,
            reuseReason: 'operation_binding_mismatch',
          };
        }

        if (existing.replacedByTokenHash !== null) {
          await this.sessions.findByTokenHashForUpdate(
            existing.replacedByTokenHash,
            tx,
          );
        }

        let operation = await this.sessions.findRotationForUpdate(
          operationKeyHash,
          tx,
        );

        if (operation !== null) {
          if (operation.status === 'SUCCEEDED') {
            const oldSession = await this.sessions.findSessionForUpdateById(
              operation.oldRefreshSessionId,
              tx,
            );
            if (oldSession !== null && oldSession.replacedByTokenHash !== null) {
              const directSuccessor = await this.sessions.findByTokenHashForUpdate(
                oldSession.replacedByTokenHash,
                tx,
              );
              if (
                directSuccessor !== null &&
                directSuccessor.familyId === existing.familyId &&
                (
                  directSuccessor.tokenHash === tokenHash ||
                  (
                    directSuccessor.replacedByTokenHash !== null &&
                    directSuccessor.replacedByTokenHash === tokenHash
                  )
                )
              ) {
                throw new UnauthorizedException({
                  code: 'REFRESH_REPLAY_STALE',
                  message: INVALID_REFRESH_MESSAGE,
                });
              }
            }
          }

          if (
            operation.status === 'SUCCEEDED' &&
            operation.expiresAt.getTime() > now.getTime()
          ) {
            const oldSession = await this.sessions.findSessionForUpdateById(
              operation.oldRefreshSessionId,
              tx,
            );
            if (
              oldSession !== null &&
              oldSession.replacedByTokenHash === tokenHash &&
              oldSession.familyId === existing.familyId &&
              operation.familyId === existing.familyId &&
              operation.userId === existing.userId
            ) {
              throw new UnauthorizedException({
                code: 'REFRESH_REPLAY_STALE',
                message: INVALID_REFRESH_MESSAGE,
              });
            }
          }

          if (
            operation.oldRefreshSessionId !== existing.id ||
            operation.oldTokenHash !== tokenHash ||
            operation.familyId !== existing.familyId ||
            operation.userId !== existing.userId
          ) {
            await this.sessions.revokeFamily(existing.familyId, now, 'operation_binding_mismatch', tx);
            return { reuseFamilyId: existing.familyId, reuseReason: 'operation_binding_mismatch' };
          }
          if (operation.expiresAt.getTime() <= now.getTime()) {
            if (operation.status === 'SUCCEEDED') {
              const transferred = await this.sessions.transferExpiredResult(
                {
                  id: operation.id,
                  operationKeyHash,
                  oldRefreshSessionId: operation.oldRefreshSessionId,
                  oldTokenHash: operation.oldTokenHash,
                  familyId: operation.familyId,
                  userId: operation.userId,
                },
                existing.expiresAt,
                existing.replacedByTokenHash,
                now,
                tx,
              );
              if (!transferred) {
                await this.sessions.revokeFamily(
                  existing.familyId,
                  now,
                  'operation_binding_mismatch',
                  tx,
                );
                return {
                  reuseFamilyId: existing.familyId,
                  reuseReason: 'operation_binding_mismatch',
                };
              }
            }
            return {
              reuseFamilyId: existing.familyId,
              reuseReason: 'idempotency_result_expired',
            };
          }
          if (operation.status === 'SUCCEEDED') {
            return this.recoverSucceededOperation(
              operation,
              existing,
              user,
              now,
              operationKeyHash,
              tx,
            );
          }
          throw new ConflictException(
            'Refresh operation is temporarily unavailable',
          );
        }

        if (existing.rotatedAt !== null) {
          await this.sessions.revokeFamily(existing.familyId, now, 'reuse', tx);
          return { reuseFamilyId: existing.familyId, reuseReason: 'reuse' };
        }

        const resultExpiresAt = new Date(now.getTime() + REFRESH_RESULT_TTL_MS);
        await this.sessions.insertPendingRotation(
          {
            operationKeyHash,
            oldRefreshSessionId: existing.id,
            oldTokenHash: tokenHash,
            familyId: existing.familyId,
            userId: existing.userId,
            expiresAt: resultExpiresAt,
          },
          tx,
        );

        operation = await this.sessions.findRotationForUpdate(
          operationKeyHash,
          tx,
        );
        if (operation === null) {
          throw new ConflictException('Refresh operation is temporarily unavailable');
        }

        if (
          operation.oldRefreshSessionId !== existing.id ||
          operation.oldTokenHash !== tokenHash ||
          operation.familyId !== existing.familyId ||
          operation.userId !== existing.userId
        ) {
          await this.sessions.revokeFamily(existing.familyId, now, 'operation_binding_mismatch', tx);
          return { reuseFamilyId: existing.familyId, reuseReason: 'operation_binding_mismatch' };
        }
        if (operation.expiresAt.getTime() <= now.getTime()) {
          if (operation.status === 'SUCCEEDED') {
            const transferred = await this.sessions.transferExpiredResult(
              {
                id: operation.id,
                operationKeyHash,
                oldRefreshSessionId: operation.oldRefreshSessionId,
                oldTokenHash: operation.oldTokenHash,
                familyId: operation.familyId,
                userId: operation.userId,
              },
              existing.expiresAt,
              existing.replacedByTokenHash,
              now,
              tx,
            );
            if (!transferred) {
              await this.sessions.revokeFamily(
                existing.familyId,
                now,
                'operation_binding_mismatch',
                tx,
              );
              return {
                reuseFamilyId: existing.familyId,
                reuseReason: 'operation_binding_mismatch',
              };
            }
          }
          return {
            reuseFamilyId: existing.familyId,
            reuseReason: 'idempotency_result_expired',
          };
        }

        if (operation.status === 'SUCCEEDED') {
          return this.recoverSucceededOperation(
            operation,
            existing,
            user,
            now,
            operationKeyHash,
            tx,
          );
        }

        if (existing.rotatedAt !== null) {
          await this.sessions.revokeFamily(existing.familyId, now, 'reuse', tx);
          return { reuseFamilyId: existing.familyId, reuseReason: 'reuse' };
        }

        const rawNextToken = this.generateToken();
        const rawCsrfToken = this.generateCsrfToken();
        const replacementHash = this.hashToken(rawNextToken);

        const won = await this.sessions.rotateActive(
          existing.id,
          tokenHash,
          now,
          replacementHash,
          tx,
        );
        if (!won) {
          await this.sessions.revokeFamily(existing.familyId, now, 'reuse', tx);
          return { reuseFamilyId: existing.familyId, reuseReason: 'reuse' };
        }

        const next = await this.sessions.create(
          {
            user: { connect: { id: existing.userId } },
            familyId: existing.familyId,
            tokenHash: replacementHash,
            csrfHash: this.hashToken(rawCsrfToken),
            expiresAt: existing.expiresAt,
          },
          tx,
        );

        const payload: RotationPayload = {
          refreshToken: rawNextToken,
          csrfToken: rawCsrfToken,
          accessToken: this.accessTokens.sign(user),
          expiresIn: this.accessTokens.expiresIn,
        };
        const aad = this.operationAad(operationKeyHash, tokenHash, existing);
        const encrypted = this.encryption.encrypt(payload, aad);
        await this.sessions.completeRotation(
          operation.id,
          encrypted,
          now,
          tx,
        );

        return {
          rawRefreshToken: rawNextToken,
          rawCsrfToken,
          accessToken: payload.accessToken,
          expiresIn: payload.expiresIn,
          session: next,
          userId: existing.userId,
        };
          },
          {
            isolationLevel: 'Serializable',
            maxWait: 2_000,
            timeout: 5_000,
          },
        );

        if ('reuseFamilyId' in outcome) {
          const code =
            outcome.reuseReason === 'replay_stale'
              ? 'REFRESH_REPLAY_STALE'
              : outcome.reuseReason === 'operation_expired'
                ? 'REFRESH_OPERATION_EXPIRED'
                : outcome.reuseReason === 'idempotency_result_expired'
                  ? 'REFRESH_OPERATION_EXPIRED'
                  : outcome.reuseReason === 'operation_binding_mismatch'
                    ? 'REFRESH_OPERATION_BINDING_MISMATCH'
                    : 'REFRESH_TOKEN_REUSE';
          throw new UnauthorizedException({
            code,
            message: INVALID_REFRESH_MESSAGE,
          });
        }
        return outcome;
      } catch (error) {
        const code = this.errorCode(error);
        if (code === 'P2034' || code === '40001') {
          if (attempt < maxRetries) {
            await this.delay(25 * 2 ** attempt);
            continue;
          }
          throw new ConflictException(
            'Refresh operation conflicted; retry with the same operation key',
          );
        }
        if (code === 'P2028' || code === 'P2010') {
          throw new ConflictException(
            'Refresh operation timed out; retry with the same operation key',
          );
        }
        throw error;
      }
    }
    throw new ConflictException('Refresh operation conflicted');
  }

  private errorCode(error: unknown): string {
    if (typeof error !== 'object' || error === null) return '';
    const message = String((error as { message?: unknown }).message ?? '');
    if (message.includes('40001') || message.includes('could not serialize')) {
      return '40001';
    }
    const candidate = String((error as { code?: unknown }).code ?? '');
    if (candidate) return candidate;
    return '';
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  private validateAndHashOperationKey(operationKey: string): string {
    if (typeof operationKey !== 'string') {
      throw new UnauthorizedException(INVALID_REFRESH_MESSAGE);
    }
    let decoded: Buffer;
    try {
      decoded = Buffer.from(operationKey, 'base64url');
    } catch {
      throw new UnauthorizedException(INVALID_REFRESH_MESSAGE);
    }
    if (decoded.length !== 32 || decoded.toString('base64url') !== operationKey) {
      throw new UnauthorizedException(INVALID_REFRESH_MESSAGE);
    }
    return crypto.createHash('sha256').update(decoded).digest('hex');
  }

  private operationAad(
    operationKeyHash: string,
    oldTokenHash: string,
    oldSession: RefreshSession,
  ): Buffer {
    return Buffer.from(
      JSON.stringify({
        operationKeyHash,
        oldTokenHash,
        familyId: oldSession.familyId,
        oldRefreshSessionId: oldSession.id,
      }),
      'utf8',
    );
  }

  private async recoverSucceededOperation(
    operation: {
      id: string;
      encryptedPayload: string | null;
      nonce: string | null;
      authenticationTag: string | null;
      payloadKeyVersion: number | null;
    },
    oldSession: RefreshSession,
    user: { id: string; email: string; role: Role; passwordChangedAt?: Date | null },
    now: Date,
    operationKeyHash: string,
    tx: Prisma.TransactionClient,
  ): Promise<RotatedRefreshSession | { reuseFamilyId: string; reuseReason: string }> {
    if (
      operation.encryptedPayload === null ||
      operation.nonce === null ||
      operation.authenticationTag === null ||
      operation.payloadKeyVersion === null
    ) {
      throw new UnauthorizedException(INVALID_REFRESH_MESSAGE);
    }

    const aad = this.operationAad(
      operationKeyHash,
      oldSession.tokenHash,
      oldSession,
    );

    const payload = this.encryption.decrypt(
      operation.encryptedPayload,
      operation.nonce,
      operation.authenticationTag,
      operation.payloadKeyVersion,
      aad,
    );

    const replacement = await this.sessions.findByTokenHashForUpdate(
      this.hashToken(payload.refreshToken),
      tx,
    );
    if (
      replacement === null ||
      replacement.familyId !== oldSession.familyId ||
      replacement.userId !== oldSession.userId ||
      replacement.rotatedAt !== null ||
      replacement.revokedAt !== null ||
      replacement.expiresAt.getTime() <= now.getTime()
    ) {
      await this.sessions.revokeFamily(
        oldSession.familyId,
        now,
        'replacement_invalid',
        tx,
      );
      return { reuseFamilyId: oldSession.familyId, reuseReason: 'replacement_invalid' };
    }

    let accessToken = payload.accessToken;
    try {
      const verified = await this.accessTokens.verify(accessToken);
      if (verified.sub !== user.id) {
        accessToken = this.accessTokens.sign(user);
      }
    } catch {
      accessToken = this.accessTokens.sign(user);
    }

    return {
      rawRefreshToken: payload.refreshToken,
      rawCsrfToken: payload.csrfToken,
      accessToken,
      expiresIn: payload.expiresIn,
      session: replacement,
      userId: oldSession.userId,
    };
  }


  /**
   * Read-only lookup used by logout. Expired, revoked and unknown tokens are
   * treated as inactive, so callers cannot distinguish them from one another.
   * Rotation and idempotency handling are untouched.
   */
  async findActiveFamilyId(
    rawToken: string,
    now = new Date(),
  ): Promise<string | null> {
    const session = await this.sessions.findByTokenHash(this.hashToken(rawToken));
    if (
      session === null ||
      session.revokedAt !== null ||
      session.expiresAt.getTime() <= now.getTime()
    ) {
      return null;
    }
    return session.familyId;
  }

  revokeFamily(
    familyId: string,
    reason: string,
    now = new Date(),
  ): Promise<number> {
    return this.sessions.revokeFamily(familyId, now, reason);
  }

  revokeUserSessions(
    userId: string,
    reason: string,
    now = new Date(),
    client?: Prisma.TransactionClient,
  ): Promise<number> {
    return client
      ? this.sessions.revokeUserSessions(userId, now, reason, client)
      : this.sessions.revokeUserSessions(userId, now, reason);
  }
}
