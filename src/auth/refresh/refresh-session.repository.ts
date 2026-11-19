import { Injectable } from '@nestjs/common';
import {
  Prisma,
  type RefreshSession,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

@Injectable()
export class RefreshSessionRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(
    data: Prisma.RefreshSessionCreateInput,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<RefreshSession> {
    return client.refreshSession.create({ data });
  }

  findByTokenHash(
    tokenHash: string,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<RefreshSession | null> {
    return client.refreshSession.findUnique({ where: { tokenHash } });
  }

  async acquireOperationKeyLock(
    operationKeyHash: string,
    client: Prisma.TransactionClient,
  ): Promise<void> {
    await client.$executeRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${operationKeyHash}, 64))
    `);
  }

  async findByTokenHashForUpdate(
    tokenHash: string,
    client: Prisma.TransactionClient,
  ): Promise<RefreshSession | null> {
    const rows = await client.$queryRaw<Array<{
      id: string;
      userId: string;
      familyId: string;
      tokenHash: string;
      csrfHash: string;
      expiresAt: Date;
      rotatedAt: Date | null;
      replacedByTokenHash: string | null;
      revokedAt: Date | null;
      revokedReason: string | null;
      createdAt: Date;
      lastUsedAt: Date | null;
    }>>(Prisma.sql`
      SELECT id,
             user_id AS "userId",
             family_id AS "familyId",
             token_hash AS "tokenHash",
             csrf_hash AS "csrfHash",
             expires_at AS "expiresAt",
             rotated_at AS "rotatedAt",
             replaced_by_token_hash AS "replacedByTokenHash",
             revoked_at AS "revokedAt",
             revoked_reason AS "revokedReason",
             created_at AS "createdAt",
             last_used_at AS "lastUsedAt"
      FROM refresh_sessions
      WHERE token_hash = ${tokenHash}
      FOR UPDATE
    `);
    return rows[0] ?? null;
  }

  async findSessionForUpdateById(
    id: string,
    client: Prisma.TransactionClient,
  ): Promise<RefreshSession | null> {
    const rows = await client.$queryRaw<Array<{
      id: string;
      userId: string;
      familyId: string;
      tokenHash: string;
      csrfHash: string;
      expiresAt: Date;
      rotatedAt: Date | null;
      replacedByTokenHash: string | null;
      revokedAt: Date | null;
      revokedReason: string | null;
      createdAt: Date;
      lastUsedAt: Date | null;
    }>>(Prisma.sql`
      SELECT id,
             user_id AS "userId",
             family_id AS "familyId",
             token_hash AS "tokenHash",
             csrf_hash AS "csrfHash",
             expires_at AS "expiresAt",
             rotated_at AS "rotatedAt",
             replaced_by_token_hash AS "replacedByTokenHash",
             revoked_at AS "revokedAt",
             revoked_reason AS "revokedReason",
             created_at AS "createdAt",
             last_used_at AS "lastUsedAt"
      FROM refresh_sessions
      WHERE id = ${id}
      FOR UPDATE
    `);
    return rows[0] ?? null;
  }

  rotateActive(
    id: string,
    tokenHash: string,
    rotatedAt: Date,
    replacedByTokenHash: string,
    client: Prisma.TransactionClient,
  ): Promise<boolean> {
    return client.refreshSession
      .updateMany({
        where: {
          id,
          tokenHash,
          rotatedAt: null,
          revokedAt: null,
          expiresAt: { gt: rotatedAt },
        },
        data: { rotatedAt, lastUsedAt: rotatedAt, replacedByTokenHash },
      })
      .then((result) => result.count === 1);
  }

  revokeFamily(
    familyId: string,
    revokedAt: Date,
    reason: string,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<number> {
    return client.refreshSession
      .updateMany({
        where: {
          familyId,
          revokedAt: null,
        },
        data: { revokedAt, revokedReason: reason },
      })
      .then((result) => result.count);
  }

  revokeUserSessions(
    userId: string,
    revokedAt: Date,
    reason: string,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<number> {
    return client.refreshSession
      .updateMany({
        where: {
          userId,
          revokedAt: null,
        },
        data: { revokedAt, revokedReason: reason },
      })
      .then((result) => result.count);
  }

  deleteExpired(
    now: Date,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<number> {
    if ('$transaction' in client) {
      return (client as PrismaService).$transaction((tx) =>
        this.deleteExpiredBounded(now, tx),
      );
    }
    return this.deleteExpiredBounded(now, client);
  }

  private async deleteExpiredBounded(
    now: Date,
    client: Prisma.TransactionClient | PrismaService,
  ): Promise<number> {
    const rows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id
      FROM refresh_sessions
      WHERE expires_at <= ${now}
        AND revoked_at IS NOT NULL
      ORDER BY expires_at
      LIMIT 500
      FOR UPDATE SKIP LOCKED
    `);
    if (rows.length === 0) return 0;
    const result = await client.refreshSession.deleteMany({
      where: { id: { in: rows.map((row) => row.id) } },
    });
    return result.count;
  }

  async insertPendingRotation(
    data: {
      operationKeyHash: string;
      oldRefreshSessionId: string;
      oldTokenHash: string;
      familyId: string;
      userId: string;
      expiresAt: Date;
    },
    client: Prisma.TransactionClient,
  ): Promise<boolean> {
    const result = await client.refreshRotationResult.createMany({
      data: {
        operationKeyHash: data.operationKeyHash,
        oldRefreshSessionId: data.oldRefreshSessionId,
        oldTokenHash: data.oldTokenHash,
        familyId: data.familyId,
        userId: data.userId,
        status: 'PENDING',
        expiresAt: data.expiresAt,
      },
      skipDuplicates: true,
    });
    return result.count === 1;
  }

  async findRotationForUpdate(
    operationKeyHash: string,
    client: Prisma.TransactionClient,
  ) {
    const rows = await client.$queryRaw<
      Array<{
        id: string;
        operationKeyHash: string;
        oldRefreshSessionId: string;
        oldTokenHash: string;
        familyId: string;
        userId: string;
        status: 'PENDING' | 'SUCCEEDED';
        encryptedPayload: string | null;
        nonce: string | null;
        authenticationTag: string | null;
        payloadKeyVersion: number | null;
        expiresAt: Date;
        completedAt: Date | null;
      }>
    >(Prisma.sql`
      SELECT id, operation_key_hash AS "operationKeyHash",
             old_refresh_session_id AS "oldRefreshSessionId",
             old_token_hash AS "oldTokenHash",
             family_id AS "familyId",
             user_id AS "userId",
             status, encrypted_payload AS "encryptedPayload",
             nonce, authentication_tag AS "authenticationTag",
             payload_key_version AS "payloadKeyVersion",
             expires_at AS "expiresAt",
             completed_at AS "completedAt"
      FROM refresh_rotation_results
      WHERE operation_key_hash = ${operationKeyHash}
      FOR UPDATE
    `);
    return rows[0] ?? null;
  }

  async findTombstoneForUpdate(
    operationKeyHash: string,
    client: Prisma.TransactionClient,
  ) {
    const rows = await client.$queryRaw<
      Array<{
        id: string;
        operationKeyHash: string;
        oldRefreshSessionId: string;
        oldTokenHash: string;
        replacementTokenHash: string | null;
        familyId: string;
        userId: string;
        familyExpiresAt: Date;
        completedAt: Date;
        createdAt: Date;
      }>
    >(Prisma.sql`
      SELECT id,
             operation_key_hash AS "operationKeyHash",
             old_refresh_session_id AS "oldRefreshSessionId",
             old_token_hash AS "oldTokenHash",
             replacement_token_hash AS "replacementTokenHash",
             family_id AS "familyId",
             user_id AS "userId",
             family_expires_at AS "familyExpiresAt",
             completed_at AS "completedAt",
             created_at AS "createdAt"
      FROM refresh_operation_tombstones
      WHERE operation_key_hash = ${operationKeyHash}
      FOR UPDATE
    `);
    return rows[0] ?? null;
  }

  async transferExpiredResult(
    result: {
      id: string;
      operationKeyHash: string;
      oldRefreshSessionId: string;
      oldTokenHash: string;
      familyId: string;
      userId: string;
    },
    familyExpiresAt: Date,
    replacementTokenHash: string | null,
    completedAt: Date,
    client: Prisma.TransactionClient,
  ): Promise<boolean> {

    const inserted = await client.refreshOperationTombstone.createMany({
      data: {
        operationKeyHash: result.operationKeyHash,
        oldRefreshSessionId: result.oldRefreshSessionId,
        oldTokenHash: result.oldTokenHash,
        replacementTokenHash,
        familyId: result.familyId,
        userId: result.userId,
        familyExpiresAt,
        completedAt,
      },
      skipDuplicates: true,
    });

    const tombstone = await this.findTombstoneForUpdate(
      result.operationKeyHash,
      client,
    );
    if (
      tombstone === null ||
      tombstone.oldRefreshSessionId !== result.oldRefreshSessionId ||
      tombstone.oldTokenHash !== result.oldTokenHash ||
      tombstone.replacementTokenHash !== replacementTokenHash ||
      tombstone.familyId !== result.familyId ||
      tombstone.userId !== result.userId ||
      tombstone.familyExpiresAt.getTime() !== familyExpiresAt.getTime()
    ) {
      return false;
    }

    await client.refreshRotationResult.delete({
      where: { id: result.id },
    });
    void inserted;
    return true;
  }

  async completeRotation(
    id: string,
    encrypted: {
      ciphertext: string;
      nonce: string;
      authenticationTag: string;
      keyVersion: number;
    },
    completedAt: Date,
    client: Prisma.TransactionClient,
  ): Promise<void> {
    await client.refreshRotationResult.update({
      where: { id },
      data: {
        status: 'SUCCEEDED',
        encryptedPayload: encrypted.ciphertext,
        nonce: encrypted.nonce,
        authenticationTag: encrypted.authenticationTag,
        payloadKeyVersion: encrypted.keyVersion,
        completedAt,
      },
    });
  }

  async cleanupExpiredRotationResults(
    now: Date,
    pendingTtlMs: number,
    client: Prisma.TransactionClient,
  ): Promise<number> {
    const pendingCutoff = new Date(now.getTime() - pendingTtlMs);
    const rows = await client.$queryRaw<Array<{
      id: string;
      operationKeyHash: string;
      oldRefreshSessionId: string;
      oldTokenHash: string;
      familyId: string;
      userId: string;
      status: 'PENDING' | 'SUCCEEDED';
      createdAt: Date;
    }>>(Prisma.sql`
      SELECT id,
             operation_key_hash AS "operationKeyHash",
             old_refresh_session_id AS "oldRefreshSessionId",
             old_token_hash AS "oldTokenHash",
             family_id AS "familyId",
             user_id AS "userId",
             status,
             created_at AS "createdAt"
      FROM refresh_rotation_results
      WHERE expires_at <= ${now}
         OR (status = 'PENDING' AND created_at <= ${pendingCutoff})
      ORDER BY created_at
      LIMIT 500
    `);
    if (rows.length === 0) return 0;

    let deleted = 0;
    for (const row of rows) {
      await this.acquireOperationKeyLock(row.operationKeyHash, client);

      const sessionRows = await client.$queryRaw<Array<{
        id: string;
        userId: string;
        familyId: string;
        tokenHash: string;
        expiresAt: Date;
        replacedByTokenHash: string | null;
      }>>(Prisma.sql`
        SELECT id,
               user_id AS "userId",
               family_id AS "familyId",
               token_hash AS "tokenHash",
               expires_at AS "expiresAt",
               replaced_by_token_hash AS "replacedByTokenHash"
        FROM refresh_sessions
        WHERE id = ${row.oldRefreshSessionId}
        FOR UPDATE SKIP LOCKED
      `);
      if (sessionRows.length === 0) continue;

      const resultRows = await client.$queryRaw<Array<{
        id: string;
        status: 'PENDING' | 'SUCCEEDED';
        expiresAt: Date;
      }>>(Prisma.sql`
        SELECT id, status, expires_at AS "expiresAt"
        FROM refresh_rotation_results
        WHERE id = ${row.id}
        FOR UPDATE SKIP LOCKED
      `);
      if (resultRows.length === 0) continue;

      if (resultRows[0].status === 'SUCCEEDED') {
        const session = sessionRows[0];
        if (
          resultRows[0].expiresAt.getTime() <= now.getTime()
        ) {
          const transferred = await this.transferExpiredResult(
            {
              id: row.id,
              operationKeyHash: row.operationKeyHash,
              oldRefreshSessionId: row.oldRefreshSessionId,
              oldTokenHash: row.oldTokenHash,
              familyId: row.familyId,
              userId: row.userId,
            },
            session.expiresAt,
            session.replacedByTokenHash,
            now,
            client,
          );
          if (!transferred) continue;
          deleted += 1;
        }
        continue;
      }

      const result = await client.refreshRotationResult.deleteMany({
        where: { id: row.id },
      });
      deleted += result.count;
    }

    return deleted;
  }

  async cleanupExpiredTombstones(
    now: Date,
    client: Prisma.TransactionClient,
  ): Promise<number> {
    const rows = await client.$queryRaw<Array<{
      id: string;
      operationKeyHash: string;
      oldRefreshSessionId: string;
    }>>(Prisma.sql`
      SELECT id,
             operation_key_hash AS "operationKeyHash",
             old_refresh_session_id AS "oldRefreshSessionId"
      FROM refresh_operation_tombstones
      WHERE family_expires_at <= ${now}
      ORDER BY family_expires_at
      LIMIT 500
    `);
    if (rows.length === 0) return 0;

    let deleted = 0;
    for (const row of rows) {
      await this.acquireOperationKeyLock(row.operationKeyHash, client);

      const sessionRows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id
        FROM refresh_sessions
        WHERE id = ${row.oldRefreshSessionId}
        FOR UPDATE SKIP LOCKED
      `);

      const resultRows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id
        FROM refresh_rotation_results
        WHERE operation_key_hash = ${row.operationKeyHash}
        FOR UPDATE SKIP LOCKED
      `);
      if (resultRows.length > 0) continue;

      const tombstoneRows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id
        FROM refresh_operation_tombstones
        WHERE id = ${row.id}
          AND family_expires_at <= ${now}
        FOR UPDATE SKIP LOCKED
      `);
      if (tombstoneRows.length === 0) continue;

      const result = await client.refreshOperationTombstone.deleteMany({
        where: { id: row.id },
      });
      deleted += result.count;
    }
    return deleted;
  }
}
