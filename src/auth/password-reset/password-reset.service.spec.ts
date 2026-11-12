import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { EmailService } from '../../email/email.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { UsersRepository } from '../../users/repositories/users.repository.js';
import { ForgotPasswordDto } from '../dto/forgot-password.dto.js';
import { ResetPasswordDto } from '../dto/reset-password.dto.js';
import { PasswordService } from '../password/password.service.js';
import {
  INVALID_PASSWORD_RESET_TOKEN_MESSAGE,
  PASSWORD_RESET_REQUEST_MESSAGE,
  PASSWORD_RESET_SUCCESS_MESSAGE,
  PASSWORD_RESET_TOKEN_TTL_MS,
} from './password-reset.constants.js';
import { PasswordResetTokenRepository } from './password-reset-token.repository.js';
import {
  hashPasswordResetToken,
  PasswordResetService,
} from './password-reset.service.js';

const USER_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const TOKEN_ID = '7a1f71e9-9d0f-44a9-a0a0-58ff9d74f2f0';
const EMAIL = 'ada.lovelace@example.com';
const OLD_PASSWORD = 'OldPassword123';
const NEW_PASSWORD = 'N3w!Password456';

const buildForgotDto = (overrides: Partial<ForgotPasswordDto> = {}) =>
  Object.assign(new ForgotPasswordDto(), { email: EMAIL, ...overrides });

const buildResetDto = (overrides: Partial<ResetPasswordDto> = {}) =>
  Object.assign(new ResetPasswordDto(), {
    token: 'a'.repeat(43),
    newPassword: NEW_PASSWORD,
    confirmPassword: NEW_PASSWORD,
    ...overrides,
  });

const buildUser = (overrides: Record<string, unknown> = {}) => ({
  id: USER_ID,
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: EMAIL,
  passwordHash: 'placeholder-hash',
  phone: null,
  status: 'ACTIVE',
  role: 'CUSTOMER',
  emailVerifiedAt: new Date('2026-01-02T00:00:00.000Z'),
  lastLoginAt: null,
  passwordChangedAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

const buildToken = (overrides: Record<string, unknown> = {}) => ({
  id: TOKEN_ID,
  userId: USER_ID,
  tokenHash: hashPasswordResetToken(buildResetDto().token),
  expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  usedAt: null,
  createdAt: new Date(),
  ...overrides,
});

describe('PasswordResetService', () => {
  let service: PasswordResetService;
  let passwordService: PasswordService;
  let findByEmail: ReturnType<typeof vi.fn>;
  let findById: ReturnType<typeof vi.fn>;
  let updatePassword: ReturnType<typeof vi.fn>;
  let createToken: ReturnType<typeof vi.fn>;
  let findByTokenHash: ReturnType<typeof vi.fn>;
  let consumeActive: ReturnType<typeof vi.fn>;
  let invalidateOutstanding: ReturnType<typeof vi.fn>;
  let deleteByTokenHash: ReturnType<typeof vi.fn>;
  let sendPasswordReset: ReturnType<typeof vi.fn>;
  let emailService: { isConfigured: boolean; sendPasswordReset: typeof sendPasswordReset };
  let prismaTransaction: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    findByEmail = vi.fn();
    findById = vi.fn();
    updatePassword = vi.fn();
    createToken = vi.fn();
    findByTokenHash = vi.fn();
    consumeActive = vi.fn();
    invalidateOutstanding = vi.fn();
    deleteByTokenHash = vi.fn();
    sendPasswordReset = vi.fn();
    emailService = { isConfigured: true, sendPasswordReset };
    prismaTransaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({}),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PasswordResetService,
        PasswordService,
        {
          provide: UsersRepository,
          useValue: { findByEmail, findById, updatePassword },
        },
        {
          provide: PasswordResetTokenRepository,
          useValue: {
            create: createToken,
            findByTokenHash,
            consumeActive,
            invalidateOutstandingForUser: invalidateOutstanding,
            deleteByTokenHash,
          },
        },
        { provide: EmailService, useValue: emailService },
        {
          provide: PrismaService,
          useValue: { $transaction: prismaTransaction },
        },
      ],
    }).compile();

    service = module.get(PasswordResetService);
    passwordService = module.get(PasswordService);
  });

  describe('requestReset', () => {
    it('returns the generic message for an unknown email without creating a token', async () => {
      findByEmail.mockResolvedValue(null);

      await expect(service.requestReset(buildForgotDto())).resolves.toEqual({
        message: PASSWORD_RESET_REQUEST_MESSAGE,
      });

      expect(createToken).not.toHaveBeenCalled();
      expect(sendPasswordReset).not.toHaveBeenCalled();
    });

    it('stores only a hash and emails the raw token', async () => {
      findByEmail.mockResolvedValue(buildUser());
      createToken.mockResolvedValue({});
      sendPasswordReset.mockResolvedValue(undefined);

      await expect(
        service.requestReset(buildForgotDto({ email: '  ADA@EXAMPLE.COM ' })),
      ).resolves.toEqual({ message: PASSWORD_RESET_REQUEST_MESSAGE });

      const created = createToken.mock.calls[0][0] as {
        userId: string;
        tokenHash: string;
        expiresAt: Date;
      };
      const sent = sendPasswordReset.mock.calls[0][0] as {
        to: string;
        token: string;
      };

      expect(created.userId).toBe(USER_ID);
      expect(created.tokenHash).toHaveLength(64);
      expect(created.tokenHash).not.toBe(sent.token);
      expect(created.tokenHash).toBe(hashPasswordResetToken(sent.token));
      expect(sent.to).toBe(EMAIL);
      expect(sent.token.length).toBeGreaterThanOrEqual(40);
      expect(created.expiresAt.getTime()).toBeGreaterThan(
        Date.now() + PASSWORD_RESET_TOKEN_TTL_MS - 5_000,
      );
    });

    it('does not reveal an inactive account', async () => {
      findByEmail.mockResolvedValue(buildUser({ status: 'SUSPENDED' }));

      await expect(service.requestReset(buildForgotDto())).resolves.toEqual({
        message: PASSWORD_RESET_REQUEST_MESSAGE,
      });
      expect(createToken).not.toHaveBeenCalled();
    });

    it('returns 503 instead of pretending when SMTP is not configured', async () => {
      emailService.isConfigured = false;

      await expect(service.requestReset(buildForgotDto())).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(findByEmail).not.toHaveBeenCalled();
    });

    it('removes the token and returns 503 when delivery fails', async () => {
      findByEmail.mockResolvedValue(buildUser());
      createToken.mockResolvedValue({});
      sendPasswordReset.mockRejectedValue(new Error('smtp down'));

      await expect(service.requestReset(buildForgotDto())).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );

      expect(deleteByTokenHash).toHaveBeenCalledWith(
        createToken.mock.calls[0][0].tokenHash,
      );
    });
  });

  describe('resetPassword', () => {
    it('hashes the new password, consumes the token and invalidates siblings', async () => {
      findByTokenHash.mockResolvedValue(buildToken());
      findById.mockResolvedValue(
        buildUser({ passwordChangedAt: null, emailVerifiedAt: null }),
      );
      consumeActive.mockResolvedValue(true);
      updatePassword.mockResolvedValue(buildUser());
      invalidateOutstanding.mockResolvedValue(1);

      await expect(service.resetPassword(buildResetDto())).resolves.toEqual({
        message: PASSWORD_RESET_SUCCESS_MESSAGE,
      });

      expect(prismaTransaction).toHaveBeenCalledTimes(1);
      expect(consumeActive).toHaveBeenCalledWith(
        hashPasswordResetToken(buildResetDto().token),
        expect.any(Date),
        expect.anything(),
      );

      const update = updatePassword.mock.calls[0] as [
        string,
        {
          passwordHash: string;
          passwordChangedAt: Date;
          emailVerifiedAt: Date | null;
        },
        unknown,
      ];
      expect(update[0]).toBe(USER_ID);
      expect(update[1].passwordHash).not.toBe(NEW_PASSWORD);
      expect(update[1].passwordHash.startsWith('$argon2id$')).toBe(true);
      await expect(
        passwordService.verify(update[1].passwordHash, NEW_PASSWORD),
      ).resolves.toBe(true);
      await expect(
        passwordService.verify(update[1].passwordHash, OLD_PASSWORD),
      ).resolves.toBe(false);
      expect(update[1].emailVerifiedAt).toEqual(update[1].passwordChangedAt);

      expect(invalidateOutstanding).toHaveBeenCalledWith(
        USER_ID,
        update[1].passwordChangedAt,
        TOKEN_ID,
        expect.anything(),
      );
    });

    it('lets a Google-created account set a local password', async () => {
      const verifiedAt = new Date('2026-02-01T00:00:00.000Z');
      findByTokenHash.mockResolvedValue(buildToken());
      findById.mockResolvedValue(
        buildUser({
          passwordHash: '$argon2id$random-unguessable',
          emailVerifiedAt: verifiedAt,
          passwordChangedAt: null,
        }),
      );
      consumeActive.mockResolvedValue(true);
      updatePassword.mockResolvedValue(buildUser());
      invalidateOutstanding.mockResolvedValue(0);

      await service.resetPassword(buildResetDto());

      const update = updatePassword.mock.calls[0] as [
        string,
        { passwordHash: string; emailVerifiedAt: Date | null },
      ];
      await expect(
        passwordService.verify(update[1].passwordHash, NEW_PASSWORD),
      ).resolves.toBe(true);
      // The already-verified Google address keeps its original timestamp.
      expect(update[1].emailVerifiedAt).toEqual(verifiedAt);
    });

    it('rejects an unknown token without touching the password', async () => {
      findByTokenHash.mockResolvedValue(null);

      await expect(service.resetPassword(buildResetDto())).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(updatePassword).not.toHaveBeenCalled();
    });

    it('rejects an expired token', async () => {
      findByTokenHash.mockResolvedValue(
        buildToken({ expiresAt: new Date(Date.now() - 1) }),
      );

      await expect(service.resetPassword(buildResetDto())).rejects.toThrow(
        INVALID_PASSWORD_RESET_TOKEN_MESSAGE,
      );
      expect(updatePassword).not.toHaveBeenCalled();
    });

    it('rejects an already-used token', async () => {
      findByTokenHash.mockResolvedValue(
        buildToken({ usedAt: new Date('2026-02-01T00:00:00.000Z') }),
      );

      await expect(service.resetPassword(buildResetDto())).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(updatePassword).not.toHaveBeenCalled();
    });

    it('rejects concurrent reuse when the atomic consume loses the race', async () => {
      findByTokenHash.mockResolvedValue(buildToken());
      findById.mockResolvedValue(buildUser());
      consumeActive.mockResolvedValue(false);

      await expect(service.resetPassword(buildResetDto())).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(updatePassword).not.toHaveBeenCalled();
      expect(invalidateOutstanding).not.toHaveBeenCalled();
    });

    it('rejects a token whose account is no longer active', async () => {
      findByTokenHash.mockResolvedValue(buildToken());
      findById.mockResolvedValue(buildUser({ status: 'SUSPENDED' }));

      await expect(service.resetPassword(buildResetDto())).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(updatePassword).not.toHaveBeenCalled();
    });
  });
});
