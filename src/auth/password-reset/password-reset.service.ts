import crypto from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ACTIVE_USER_STATUS } from '../../common/constants/user-status.constants.js';
import { normalizeEmail } from '../../common/utils/normalize-email.js';
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
  PASSWORD_RESET_TEMPORARILY_UNAVAILABLE_MESSAGE,
  PASSWORD_RESET_TOKEN_BYTES,
  PASSWORD_RESET_TOKEN_TTL_MINUTES,
  PASSWORD_RESET_TOKEN_TTL_MS,
} from './password-reset.constants.js';
import { PasswordResetTokenRepository } from './password-reset-token.repository.js';

export interface PasswordResetMessage {
  message: string;
}

@Injectable()
export class PasswordResetService {
  constructor(
    private readonly usersRepository: UsersRepository,
    private readonly tokenRepository: PasswordResetTokenRepository,
    private readonly passwordService: PasswordService,
    private readonly emailService: EmailService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Starts the reset flow.
   *
   * The response is intentionally identical for a registered and an unknown
   * address. A missing account still performs the token generation so the two
   * paths do the same work up to the database lookup.
   */
  async requestReset(dto: ForgotPasswordDto): Promise<PasswordResetMessage> {
    if (!this.emailService.isConfigured) {
      // No SMTP provider: do not claim a message was sent.
      throw new ServiceUnavailableException(
        PASSWORD_RESET_TEMPORARILY_UNAVAILABLE_MESSAGE,
      );
    }

    const email = normalizeEmail(dto.email);
    const rawToken = crypto
      .randomBytes(PASSWORD_RESET_TOKEN_BYTES)
      .toString('base64url');
    const tokenHash = hashPasswordResetToken(rawToken);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + PASSWORD_RESET_TOKEN_TTL_MS);

    const user = await this.usersRepository.findByEmail(email);

    if (!user || user.status !== ACTIVE_USER_STATUS) {
      return { message: PASSWORD_RESET_REQUEST_MESSAGE };
    }

    await this.tokenRepository.create({
      userId: user.id,
      tokenHash,
      expiresAt,
    });

    try {
      await this.emailService.sendPasswordReset({
        to: user.email,
        firstName: user.firstName,
        token: rawToken,
        expiresInMinutes: PASSWORD_RESET_TOKEN_TTL_MINUTES,
      });
    } catch {
      // The raw token never left the process, so remove the unusable row.
      await this.tokenRepository.deleteByTokenHash(tokenHash);
      throw new ServiceUnavailableException(
        PASSWORD_RESET_TEMPORARILY_UNAVAILABLE_MESSAGE,
      );
    }

    return { message: PASSWORD_RESET_REQUEST_MESSAGE };
  }

  /**
   * Consumes a valid token and replaces the local password.
   *
   * The database write is the authority on single use: `consumeActive` only
   * updates an unused, unexpired row, so two concurrent requests presenting the
   * same link cannot both succeed. Hashing happens before the transaction to
   * keep the row locks short.
   */
  async resetPassword(dto: ResetPasswordDto): Promise<PasswordResetMessage> {
    const tokenHash = hashPasswordResetToken(dto.token);
    const now = new Date();

    const token = await this.tokenRepository.findByTokenHash(tokenHash);

    if (
      !token ||
      token.usedAt !== null ||
      token.expiresAt.getTime() <= now.getTime()
    ) {
      throw new BadRequestException(INVALID_PASSWORD_RESET_TOKEN_MESSAGE);
    }

    const user = await this.usersRepository.findById(token.userId);

    if (!user || user.status !== ACTIVE_USER_STATUS) {
      throw new BadRequestException(INVALID_PASSWORD_RESET_TOKEN_MESSAGE);
    }

    const passwordHash = await this.passwordService.hash(dto.newPassword);
    const passwordChangedAt = new Date();

    await this.prisma.$transaction(async (tx) => {
      const consumed = await this.tokenRepository.consumeActive(
        tokenHash,
        passwordChangedAt,
        tx,
      );

      if (!consumed) {
        // Another request won the race, or the token expired between the read
        // and this write. Either way this link is no longer usable.
        throw new BadRequestException(INVALID_PASSWORD_RESET_TOKEN_MESSAGE);
      }

      await this.usersRepository.updatePassword(
        user.id,
        {
          passwordHash,
          passwordChangedAt,
          // Possession of the emailed link proves control of this address.
          emailVerifiedAt: user.emailVerifiedAt ?? passwordChangedAt,
        },
        tx,
      );

      await this.tokenRepository.invalidateOutstandingForUser(
        user.id,
        passwordChangedAt,
        token.id,
        tx,
      );
    });

    return { message: PASSWORD_RESET_SUCCESS_MESSAGE };
  }
}

/**
 * SHA-256 digest of a reset token.
 *
 * The database stores this digest only. Because the token is 256 bits of
 * randomness, a fast hash is sufficient — unlike a password, the input is not
 * guessable to begin with.
 */
export function hashPasswordResetToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}
