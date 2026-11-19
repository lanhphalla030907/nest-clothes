import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { Role } from '../../generated/prisma/enums.js';
import { RefreshSessionRepository } from './refresh-session.repository.js';
import { RefreshTokenService } from './refresh-token.service.js';
import { REFRESH_SESSION_TTL_MS } from './refresh-token.constants.js';
import { RefreshResultEncryptionService } from './refresh-result-encryption.service.js';
import { AccessTokenService } from '../jwt/access-token.service.js';

const USER_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const OPERATION_KEY = Buffer.alloc(32, 7).toString('base64url');

const buildSession = (overrides: Record<string, unknown> = {}) =>
  ({
    id: '1f2504e0-4f89-41d3-8a9b-0c1d2e3f4a5b',
    userId: USER_ID,
    familyId: '9f2504e0-4f89-41d3-8a9b-0c1d2e3f4a5b',
    tokenHash: 'hash',
    csrfHash: 'csrf',
    expiresAt: new Date('2026-11-25T19:20:00.000Z'),
    rotatedAt: null,
    replacedByTokenHash: null,
    revokedAt: null,
    revokedReason: null,
    createdAt: new Date(),
    lastUsedAt: null,
    ...overrides,
  });

describe('RefreshTokenService', () => {
  let repository: {
    create: ReturnType<typeof vi.fn>;
    findByTokenHash: ReturnType<typeof vi.fn>;
    findByTokenHashForUpdate: ReturnType<typeof vi.fn>;
    findSessionForUpdateById: ReturnType<typeof vi.fn>;
    acquireOperationKeyLock: ReturnType<typeof vi.fn>;
    rotateActive: ReturnType<typeof vi.fn>;
    revokeFamily: ReturnType<typeof vi.fn>;
    revokeUserSessions: ReturnType<typeof vi.fn>;
    insertPendingRotation: ReturnType<typeof vi.fn>;
    findRotationForUpdate: ReturnType<typeof vi.fn>;
    completeRotation: ReturnType<typeof vi.fn>;
    findTombstoneForUpdate: ReturnType<typeof vi.fn>;
    transferExpiredResult: ReturnType<typeof vi.fn>;
  };
  let prisma: {
    $transaction: ReturnType<typeof vi.fn>;
  };
  let tx: {
    $executeRaw: ReturnType<typeof vi.fn>;
    user: { findUnique: ReturnType<typeof vi.fn> };
  };
  let service: RefreshTokenService;

  beforeEach(() => {
    repository = {
      create: vi.fn(),
      findByTokenHash: vi.fn(),
      findByTokenHashForUpdate: vi.fn(),
      findSessionForUpdateById: vi.fn(),
      acquireOperationKeyLock: vi.fn().mockResolvedValue(undefined),
      rotateActive: vi.fn(),
      revokeFamily: vi.fn().mockResolvedValue(1),
      revokeUserSessions: vi.fn().mockResolvedValue(0),
      insertPendingRotation: vi.fn().mockResolvedValue(true),
      findRotationForUpdate: vi.fn(),
      completeRotation: vi.fn().mockResolvedValue(undefined),
      findTombstoneForUpdate: vi.fn().mockResolvedValue(null),
      transferExpiredResult: vi.fn().mockResolvedValue(true),
    };
    repository.findByTokenHashForUpdate.mockImplementation(async (tokenHash: string) =>
      repository.findByTokenHash(tokenHash),
    );
    repository.findSessionForUpdateById.mockResolvedValue(buildSession());
    repository.findRotationForUpdate.mockImplementation(async () => ({
      id: 'rotation-1',
      operationKeyHash: 'operation-hash',
      oldRefreshSessionId: '1f2504e0-4f89-41d3-8a9b-0c1d2e3f4a5b',
      oldTokenHash: 'hash',
      familyId: '9f2504e0-4f89-41d3-8a9b-0c1d2e3f4a5b',
      userId: USER_ID,
      status: 'PENDING',
      encryptedPayload: null,
      nonce: null,
      authenticationTag: null,
      payloadKeyVersion: null,
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      completedAt: null,
    }));
    tx = {
      $executeRaw: vi.fn().mockResolvedValue(0),
      user: {
        findUnique: vi.fn().mockResolvedValue({
          id: USER_ID,
          status: 'ACTIVE',
          role: Role.CUSTOMER,
        }),
      },
    };
    prisma = {
      $transaction: vi.fn(async (callback: (client: unknown) => Promise<unknown>) =>
        callback(tx),
      ),
    };
    const encryption = {
      encrypt: vi.fn().mockReturnValue({
        ciphertext: 'ciphertext',
        nonce: 'nonce',
        authenticationTag: 'tag',
        keyVersion: 1,
      }),
      decrypt: vi.fn(),
    } as unknown as RefreshResultEncryptionService;
    const accessTokens = {
      sign: vi.fn().mockReturnValue('new-access-token'),
      verify: vi.fn().mockResolvedValue({ sub: USER_ID }),
      expiresIn: '15m',
    } as unknown as AccessTokenService;
    service = new RefreshTokenService(
      prisma as never,
      repository as unknown as RefreshSessionRepository,
      encryption,
      accessTokens,
    );
  });

  it('generates a 32-byte random refresh token and a SHA-256 hash', () => {
    const raw = service.generateToken();
    expect(Buffer.from(raw, 'base64url')).toHaveLength(32);
    expect(service.hashToken(raw)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('binds CSRF to the exact session named by the refresh token', async () => {
    const rawRefresh = 'refresh-a';
    const rawCsrf = 'csrf-for-a';
    repository.findByTokenHash.mockResolvedValue(
      buildSession({ csrfHash: service.hashToken(rawCsrf) }),
    );

    expect(await service.csrfBindingMatches(rawRefresh, rawCsrf)).toBe(true);
    expect(await service.csrfBindingMatches(rawRefresh, 'csrf-from-b')).toBe(false);
    expect(repository.findByTokenHash).toHaveBeenCalledWith(service.hashToken(rawRefresh));
  });

  it('creates a session with an absolute seven-day expiration', async () => {
    const now = new Date('2026-11-18T19:20:00.000Z');
    const session = buildSession({
      expiresAt: new Date(now.getTime() + REFRESH_SESSION_TTL_MS),
    });
    repository.create.mockResolvedValue(session);

    const issued = await service.createSession(USER_ID, now);

    expect(issued.session.expiresAt.getTime()).toBe(
      now.getTime() + REFRESH_SESSION_TTL_MS,
    );
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        familyId: expect.any(String),
        tokenHash: service.hashToken(issued.rawRefreshToken),
        csrfHash: service.hashToken(issued.rawCsrfToken),
        expiresAt: issued.session.expiresAt,
      }),
    );
  });

  it('rejects unknown and expired refresh tokens', async () => {
    repository.findByTokenHash.mockResolvedValueOnce(null);
    await expect(service.rotate('unknown', OPERATION_KEY)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    repository.findByTokenHash.mockResolvedValueOnce(
      buildSession({ expiresAt: new Date('2020-01-01T00:00:00.000Z') }),
    );
    await expect(
      service.rotate('expired', OPERATION_KEY),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects deleted or inactive users and revokes their family', async () => {
    repository.findByTokenHash.mockResolvedValue(buildSession());
    tx.user.findUnique.mockResolvedValueOnce(null);

    await expect(service.rotate('inactive-user-token', OPERATION_KEY)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(repository.revokeFamily).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Date),
      'account_inactive',
      tx,
    );
  });

  it('requires a 32-byte Base64URL operation key', async () => {
    await expect(
      service.rotate('inactive-user-token', 'too-short'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('retries P2034 conflicts with bounded backoff', async () => {
    prisma.$transaction
      .mockRejectedValueOnce({ code: 'P2034' })
      .mockRejectedValueOnce({ code: 'P2034' })
      .mockImplementationOnce(async (callback: (client: unknown) => Promise<unknown>) =>
        callback(tx),
      );
    const session = buildSession();
    session.tokenHash = service.hashToken('bounded-retry-token');
    repository.findByTokenHash.mockResolvedValue(session);
    repository.rotateActive.mockResolvedValue(true);
    repository.create.mockResolvedValue(buildSession({ id: 'replacement-id' }));
    repository.findRotationForUpdate.mockResolvedValue({
      id: 'rotation-1',
      operationKeyHash: 'operation-hash',
      oldRefreshSessionId: session.id,
      oldTokenHash: session.tokenHash,
      familyId: session.familyId,
      userId: USER_ID,
      status: 'PENDING',
      encryptedPayload: null,
      nonce: null,
      authenticationTag: null,
      payloadKeyVersion: null,
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      completedAt: null,
    });

    await expect(
      service.rotate('bounded-retry-token', OPERATION_KEY),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
  });

  it('does not retry permanent authentication failures', async () => {
    repository.findByTokenHash.mockResolvedValue(null);

    await expect(
      service.rotate('unknown-token', OPERATION_KEY),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('revokes all sessions for a user', async () => {
    await service.revokeUserSessions(USER_ID, 'password_reset');
    expect(repository.revokeUserSessions).toHaveBeenCalledWith(
      USER_ID,
      expect.any(Date),
      'password_reset',
    );
  });
});
