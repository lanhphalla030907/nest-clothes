import 'dotenv/config';
import { randomUUID, randomBytes } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RefreshSessionRepository } from '../src/auth/refresh/refresh-session.repository.js';
import { RefreshTokenService } from '../src/auth/refresh/refresh-token.service.js';
import { RefreshResultEncryptionService } from '../src/auth/refresh/refresh-result-encryption.service.js';
import { AccessTokenService } from '../src/auth/jwt/access-token.service.js';
import { JwtService } from '@nestjs/jwt';
import { readJwtSettings } from '../src/auth/jwt/jwt.config.js';
import { resolveTestDatabaseUrl } from '../scripts/test-database.mjs';

describe(
  'Refresh rotation PostgreSQL integration',
  () => {
    let prisma: PrismaService;
    let repository: RefreshSessionRepository;
    let encryption: RefreshResultEncryptionService;
    let accessTokens: AccessTokenService;
    let service: RefreshTokenService;
    const createdUserIds: string[] = [];

    beforeAll(() => {
      const testDatabaseUrl = resolveTestDatabaseUrl();
      process.env.TEST_DATABASE_URL = testDatabaseUrl;
      const url = new URL(testDatabaseUrl);
      if (!/test/i.test(url.pathname)) {
        throw new Error('Refresh rotation integration requires a test database');
      }
      process.env.DATABASE_URL = testDatabaseUrl;
      process.env.REFRESH_RESULT_ENCRYPTION_KEYS = JSON.stringify({
        '1': randomBytes(32).toString('base64'),
        '2': randomBytes(32).toString('base64'),
      });
      process.env.REFRESH_RESULT_ENCRYPTION_ACTIVE_VERSION = '2';

      prisma = new PrismaService();
      repository = new RefreshSessionRepository(prisma);
      encryption = new RefreshResultEncryptionService();
      accessTokens = new AccessTokenService(
        new JwtService({}),
        readJwtSettings({
          JWT_ACCESS_SECRET: 'integration-test-signing-secret-long-enough',
          JWT_ACCESS_EXPIRES_IN: '15m',
        }),
      );
      service = new RefreshTokenService(
        prisma,
        repository,
        encryption,
        accessTokens,
      );
    });

    afterAll(async () => {
      for (const userId of createdUserIds) {
        await prisma.user.deleteMany({ where: { id: userId } });
      }
      await prisma.$disconnect();
    });

    const createSession = async () => {
      const userId = randomUUID();
      await prisma.user.create({
        data: {
          id: userId,
          firstName: 'Refresh',
          lastName: 'Integration',
          email: `refresh-${randomUUID()}@example.test`,
          passwordHash: 'not-used',
          status: 'ACTIVE',
        },
      });
      createdUserIds.push(userId);
      const issued = await service.createSession(userId);
      return { userId, issued };
    };

    it('allows 20 simultaneous requests with the same operation key', async () => {
      const { issued } = await createSession();
      const operationKey = randomBytes(32).toString('base64url');

      const outcomes = await Promise.all(
        Array.from({ length: 20 }, () =>
          service.rotate(issued.rawRefreshToken, operationKey),
        ),
      );

      expect(outcomes).toHaveLength(20);
      for (const outcome of outcomes) {
        expect(outcome.rawRefreshToken).toBe(outcomes[0].rawRefreshToken);
      }

      const oldHash = service.hashToken(issued.rawRefreshToken);
      const oldSession = await prisma.refreshSession.findUnique({
        where: { tokenHash: oldHash },
      });
      expect(oldSession?.rotatedAt).not.toBeNull();
      expect(oldSession?.replacedByTokenHash).toBe(
        service.hashToken(outcomes[0].rawRefreshToken),
      );

      const replacementCount = await prisma.refreshSession.count({
        where: {
          familyId: oldSession!.familyId,
          rotatedAt: null,
        },
      });
      expect(replacementCount).toBe(1);
    });

    it('revokes the family for a different key on the same old token', async () => {
      const { issued } = await createSession();
      await expect(
        service.rotate(
          issued.rawRefreshToken,
          randomBytes(32).toString('base64url'),
        ),
      ).resolves.toBeDefined();

      await expect(
        service.rotate(
          issued.rawRefreshToken,
          randomBytes(32).toString('base64url'),
        ),
      ).rejects.toBeDefined();
    });

    it('allows only one winner for concurrent A/KeyA and A/KeyB', async () => {
      const { issued } = await createSession();
      const keyA = randomBytes(32).toString('base64url');
      const keyB = randomBytes(32).toString('base64url');

      const outcomes = await Promise.allSettled([
        service.rotate(issued.rawRefreshToken, keyA),
        service.rotate(issued.rawRefreshToken, keyB),
      ]);

      expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);

      const oldHash = service.hashToken(issued.rawRefreshToken);
      const oldSession = await prisma.refreshSession.findUnique({
        where: { tokenHash: oldHash },
      });
      expect(oldSession?.rotatedAt).not.toBeNull();

      const replacementCount = await prisma.refreshSession.count({
        where: {
          familyId: oldSession!.familyId,
          rotatedAt: null,
        },
      });
      expect(replacementCount).toBe(1);

      const activeFamilyCount = await prisma.refreshSession.count({
        where: {
          familyId: oldSession!.familyId,
          revokedAt: null,
        },
      });
      expect(activeFamilyCount).toBe(0);
    });

    it('does not delete active PENDING or SUCCEEDED rotation results', async () => {
      const { issued, userId } = await createSession();
      const oldHash = service.hashToken(issued.rawRefreshToken);
      const oldSession = await prisma.refreshSession.findUnique({
        where: { tokenHash: oldHash },
      });

      const pendingKey = randomBytes(32).toString('base64url');
      await prisma.refreshRotationResult.create({
        data: {
          operationKeyHash: service.hashOperationKey(pendingKey),
          oldRefreshSessionId: oldSession!.id,
          oldTokenHash: oldHash,
          familyId: oldSession!.familyId,
          userId,
          status: 'PENDING',
          expiresAt: new Date(Date.now() + 60_000),
        },
      });

      const succeededKey = randomBytes(32).toString('base64url');
      await prisma.refreshRotationResult.create({
        data: {
          operationKeyHash: service.hashOperationKey(succeededKey),
          oldRefreshSessionId: oldSession!.id,
          oldTokenHash: oldHash,
          familyId: oldSession!.familyId,
          userId,
          status: 'SUCCEEDED',
          encryptedPayload: 'ciphertext',
          nonce: 'nonce',
          authenticationTag: 'tag',
          payloadKeyVersion: 1,
          expiresAt: new Date(Date.now() + 60_000),
          completedAt: new Date(),
        },
      });

      await prisma.$transaction(async (tx) => {
        await repository.cleanupExpiredRotationResults(
          new Date(),
          60_000,
          tx,
        );
      });

      expect(
        await prisma.refreshRotationResult.count({
          where: {
            operationKeyHash: {
              in: [
                service.hashOperationKey(pendingKey),
                service.hashOperationKey(succeededKey),
              ],
            },
          },
        }),
      ).toBe(2);
    });

    it('cleanup racing with rotation preserves the refresh session', async () => {
      const { issued } = await createSession();
      const operationKey = randomBytes(32).toString('base64url');
      const oldHash = service.hashToken(issued.rawRefreshToken);

      const lockHolder = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT id
          FROM refresh_sessions
          WHERE token_hash = ${oldHash}
          FOR UPDATE
        `;
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      const [cleanupResult] = await Promise.all([
        prisma.$transaction(async (tx) =>
          repository.cleanupExpiredRotationResults(
            new Date(),
            60_000,
            tx,
          ),
        ),
        lockHolder,
        service.rotate(issued.rawRefreshToken, operationKey),
      ]);

      expect(cleanupResult).toBeGreaterThanOrEqual(0);
      const oldSession = await prisma.refreshSession.findUnique({
        where: { tokenHash: oldHash },
      });
      expect(oldSession?.rotatedAt).not.toBeNull();
    });

    it('cleanup and same-key replay serialize without deleting the result', async () => {
      const { issued } = await createSession();
      const operationKey = randomBytes(32).toString('base64url');
      const first = await service.rotate(issued.rawRefreshToken, operationKey);

      await Promise.all([
        prisma.$transaction(async (tx) => {
          await repository.cleanupExpiredRotationResults(
            new Date(),
            60_000,
            tx,
          );
        }),
        service.rotate(issued.rawRefreshToken, operationKey),
      ]);

      const retry = await service.rotate(issued.rawRefreshToken, operationKey);
      expect(retry.rawRefreshToken).toBe(first.rawRefreshToken);
    });

    it('recovers a lost response only with the exact old token and operation key', async () => {
      const { issued } = await createSession();
      const operationKey = randomBytes(32).toString('base64url');
      const first = await service.rotate(issued.rawRefreshToken, operationKey);
      const retry = await service.rotate(issued.rawRefreshToken, operationKey);

      expect(retry.rawRefreshToken).toBe(first.rawRefreshToken);
      await expect(
        service.rotate(issued.rawRefreshToken, randomBytes(32).toString('base64url')),
      ).rejects.toBeDefined();
    });

    it('rejects expired idempotency results and family expiry', async () => {
      const { issued } = await createSession();
      const operationKey = randomBytes(32).toString('base64url');
      await service.rotate(issued.rawRefreshToken, operationKey);

      const oldHash = service.hashToken(issued.rawRefreshToken);
      await prisma.refreshRotationResult.updateMany({
        where: { operationKeyHash: service.hashOperationKey(operationKey) },
        data: { expiresAt: new Date(Date.now() - 1) },
      });
      const expiredOperations = await prisma.refreshRotationResult.findMany({
        where: { operationKeyHash: service.hashOperationKey(operationKey) },
      });
      expect(expiredOperations).toHaveLength(1);
      expect(expiredOperations[0].expiresAt.getTime()).toBeLessThan(Date.now());
      await expect(
        service.rotate(issued.rawRefreshToken, operationKey),
      ).rejects.toBeDefined();

      const tombstones = await prisma.refreshOperationTombstone.findMany({
        where: { operationKeyHash: service.hashOperationKey(operationKey) },
      });
      expect(tombstones).toHaveLength(1);
      expect(tombstones[0].oldTokenHash).toBe(oldHash);
      expect(tombstones[0].replacementTokenHash).not.toBeNull();

      const familyCount = await prisma.refreshSession.count({
        where: {
          familyId: tombstones[0].familyId,
          revokedAt: null,
        },
      });
      expect(familyCount).toBeGreaterThan(0);

      await prisma.refreshSession.updateMany({
        where: { tokenHash: oldHash },
        data: { expiresAt: new Date(Date.now() - 1) },
      });
      await expect(
        service.rotate(issued.rawRefreshToken, randomBytes(32).toString('base64url')),
      ).rejects.toBeDefined();
    });

    it('B plus Key A with active result returns stale replay without a family revoke or replacement', async () => {
      const { issued } = await createSession();
      const keyA = randomBytes(32).toString('base64url');
      const first = await service.rotate(issued.rawRefreshToken, keyA);

      try {
        await service.rotate(first.rawRefreshToken, keyA);
        throw new Error('expected stale replay');
      } catch (error) {
        const response =
          typeof (error as { getResponse?: unknown }).getResponse === 'function'
            ? (error as { getResponse: () => unknown }).getResponse()
            : error;
        expect(response).toBeDefined();
      }

      const oldSession = await prisma.refreshSession.findUnique({
        where: { tokenHash: service.hashToken(issued.rawRefreshToken) },
      });
      const familyRows = await prisma.refreshSession.findMany({
        where: { familyId: oldSession!.familyId },
      });
      expect(familyRows.every((row) => row.revokedAt === null)).toBe(true);
      expect(familyRows.filter((row) => row.rotatedAt === null)).toHaveLength(1);
      expect(
        await prisma.refreshRotationResult.count({
          where: { operationKeyHash: service.hashOperationKey(keyA) },
        }),
      ).toBe(1);
    });

    it('B plus Key A after tombstone transfer returns stale replay without revoke', async () => {
      const { issued } = await createSession();
      const keyA = randomBytes(32).toString('base64url');
      const replacementB = await service.rotate(issued.rawRefreshToken, keyA);

      await prisma.refreshRotationResult.updateMany({
        where: { operationKeyHash: service.hashOperationKey(keyA) },
        data: { expiresAt: new Date(Date.now() - 1) },
      });

      await expect(
        service.rotate(issued.rawRefreshToken, keyA),
      ).rejects.toBeDefined();

      const tombstone = await prisma.refreshOperationTombstone.findUnique({
        where: { operationKeyHash: service.hashOperationKey(keyA) },
      });
      expect(tombstone).not.toBeNull();
      const oldSession = await prisma.refreshSession.findUnique({
        where: { tokenHash: service.hashToken(issued.rawRefreshToken) },
      });
      await expect(
        service.rotate(replacementB.rawRefreshToken, keyA),
      ).rejects.toBeDefined();

      expect(
        await prisma.refreshSession.count({
          where: { familyId: oldSession!.familyId, revokedAt: null },
        }),
      ).toBeGreaterThan(0);
    });

    it('mismatched tombstone binding fails closed without result deletion', async () => {
      const { issued } = await createSession();
      const keyA = randomBytes(32).toString('base64url');
      const first = await service.rotate(issued.rawRefreshToken, keyA);

      await prisma.refreshRotationResult.updateMany({
        where: { operationKeyHash: service.hashOperationKey(keyA) },
        data: { expiresAt: new Date(Date.now() - 1) },
      });

      const oldSession = await prisma.refreshSession.findUnique({
        where: { tokenHash: service.hashToken(issued.rawRefreshToken) },
      });
      await prisma.refreshOperationTombstone.create({
        data: {
          operationKeyHash: service.hashOperationKey(keyA),
          oldRefreshSessionId: oldSession!.id,
          oldTokenHash: 'mismatched-hash',
          replacementTokenHash: service.hashToken(first.rawRefreshToken),
          familyId: randomUUID(),
          userId: oldSession!.userId,
          familyExpiresAt: oldSession!.expiresAt,
          completedAt: new Date(),
        },
      });

      await expect(
        service.rotate(issued.rawRefreshToken, keyA),
      ).rejects.toBeDefined();

      expect(
        await prisma.refreshRotationResult.count({
          where: { operationKeyHash: service.hashOperationKey(keyA) },
        }),
      ).toBe(1);
      expect(
        await prisma.refreshSession.count({
          where: { familyId: oldSession!.familyId, revokedAt: null },
        }),
      ).toBe(0);
    });

    it('tombstone cleanup racing with replay leaves a valid binding', async () => {
      const { issued } = await createSession();
      const keyA = randomBytes(32).toString('base64url');
      await service.rotate(issued.rawRefreshToken, keyA);

      await prisma.refreshRotationResult.updateMany({
        where: { operationKeyHash: service.hashOperationKey(keyA) },
        data: { expiresAt: new Date(Date.now() - 1) },
      });
      await service.rotate(issued.rawRefreshToken, keyA).catch(() => undefined);

      const replay = await Promise.allSettled([
        prisma.$transaction(async (tx) =>
          repository.cleanupExpiredTombstones(new Date(), tx),
        ),
        service.rotate(issued.rawRefreshToken, keyA),
      ]);
      expect(replay[1].status).toBe('rejected');

      const oldSession = await prisma.refreshSession.findUnique({
        where: { tokenHash: service.hashToken(issued.rawRefreshToken) },
      });
      expect(oldSession).not.toBeNull();
    });

    it('revoked-family tombstone remains until familyExpiresAt', async () => {
      const { issued } = await createSession();
      const keyA = randomBytes(32).toString('base64url');
      await service.rotate(issued.rawRefreshToken, keyA);

      await prisma.refreshRotationResult.updateMany({
        where: { operationKeyHash: service.hashOperationKey(keyA) },
        data: { expiresAt: new Date(Date.now() - 1) },
      });
      await service.rotate(issued.rawRefreshToken, keyA).catch(() => undefined);

      const tombstone = await prisma.refreshOperationTombstone.findUnique({
        where: { operationKeyHash: service.hashOperationKey(keyA) },
      });
      expect(tombstone).not.toBeNull();

      await prisma.refreshSession.updateMany({
        where: { familyId: tombstone!.familyId },
        data: { revokedAt: new Date() },
      });
      await prisma.$transaction(async (tx) =>
        repository.cleanupExpiredTombstones(new Date(), tx),
      );
      expect(
        await prisma.refreshOperationTombstone.count({
          where: { id: tombstone!.id },
        }),
      ).toBe(1);

      await prisma.refreshOperationTombstone.update({
        where: { id: tombstone!.id },
        data: { familyExpiresAt: new Date(Date.now() - 1) },
      });
      await prisma.$transaction(async (tx) =>
        repository.cleanupExpiredTombstones(new Date(), tx),
      );
      expect(
        await prisma.refreshOperationTombstone.count({
          where: { id: tombstone!.id },
        }),
      ).toBe(0);
    });

    it('repeated expired replay creates one matching tombstone', async () => {
      const { issued } = await createSession();
      const operationKey = randomBytes(32).toString('base64url');
      await service.rotate(issued.rawRefreshToken, operationKey);

      await prisma.refreshRotationResult.updateMany({
        where: { operationKeyHash: service.hashOperationKey(operationKey) },
        data: { expiresAt: new Date(Date.now() - 1) },
      });

      await expect(
        service.rotate(issued.rawRefreshToken, operationKey),
      ).rejects.toBeDefined();
      await expect(
        service.rotate(issued.rawRefreshToken, operationKey),
      ).rejects.toBeDefined();

      const tombstones = await prisma.refreshOperationTombstone.findMany({
        where: { operationKeyHash: service.hashOperationKey(operationKey) },
      });
      expect(tombstones).toHaveLength(1);
    });

    it('rejects wrong operation and session bindings', async () => {
      const first = await createSession();
      const second = await createSession();
      const operationKey = randomBytes(32).toString('base64url');
      await service.rotate(first.issued.rawRefreshToken, operationKey);

      await expect(
        service.rotate(second.issued.rawRefreshToken, operationKey),
      ).rejects.toBeDefined();
    });

    it('rolls back a failed transaction', async () => {
      const { issued } = await createSession();
      const operationKey = randomBytes(32).toString('base64url');
      const oldHash = service.hashToken(issued.rawRefreshToken);

      await prisma.$transaction(async (tx) => {
        await tx.refreshSession.updateMany({
          where: { tokenHash: oldHash },
          data: { rotatedAt: new Date() },
        });
        throw new Error('forced rollback');
      }).catch(() => undefined);

      const old = await prisma.refreshSession.findUnique({ where: { tokenHash: oldHash } });
      expect(old?.rotatedAt).toBeNull();
      await expect(
        service.rotate(issued.rawRefreshToken, operationKey),
      ).resolves.toBeDefined();
    });

    it('authenticates AES-GCM ciphertext and supports key rotation', () => {
      const aad = Buffer.from('integration-aad');
      const payload = {
        refreshToken: 'refresh',
        csrfToken: 'csrf',
        accessToken: 'access',
        expiresIn: '15m',
      };
      const encrypted = encryption.encrypt(payload, aad);
      expect(encryption.decrypt(
        encrypted.ciphertext,
        encrypted.nonce,
        encrypted.authenticationTag,
        encrypted.keyVersion,
        aad,
      )).toEqual(payload);
      expect(() =>
        encryption.decrypt(
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.authenticationTag,
          encrypted.keyVersion,
          Buffer.from('wrong-aad'),
        ),
      ).toThrow();
    });
  },
);
