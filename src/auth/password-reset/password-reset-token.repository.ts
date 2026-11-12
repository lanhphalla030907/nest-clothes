import { Injectable } from '@nestjs/common';
import {
  Prisma,
  type PasswordResetToken,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * Persistence for {@link PasswordResetToken} rows.
 *
 * The repository deliberately never receives a raw reset token: callers hand it
 * a digest, so the only value that can reach PostgreSQL is the hash. The
 * conditional update in {@link consumeActive} is the concurrency guard that
 * makes a token single-use.
 */
@Injectable()
export class PasswordResetTokenRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(
    data: { userId: string; tokenHash: string; expiresAt: Date },
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<PasswordResetToken> {
    return client.passwordResetToken.create({ data });
  }

  findByTokenHash(
    tokenHash: string,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<PasswordResetToken | null> {
    return client.passwordResetToken.findUnique({ where: { tokenHash } });
  }

  /**
   * Removes a token that could not be delivered. The raw token never reached a
   * mailbox, so leaving a usable row behind would only be a liability.
   */
  async deleteByTokenHash(
    tokenHash: string,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<void> {
    await client.passwordResetToken.deleteMany({ where: { tokenHash } });
  }

  /**
   * Marks an unused, unexpired token as used and reports whether this caller won.
   *
   * `updateMany` is intentional: its `WHERE` clause and the write are one
   * statement, so two concurrent resets cannot both consume the same row. The
   * loser sees `count === 0` and must be refused.
   */
  async consumeActive(
    tokenHash: string,
    usedAt: Date,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<boolean> {
    const result = await client.passwordResetToken.updateMany({
      where: {
        tokenHash,
        usedAt: null,
        expiresAt: { gt: usedAt },
      },
      data: { usedAt },
    });

    return result.count === 1;
  }

  /**
   * Consumes every other outstanding token for the user after a successful reset.
   */
  async invalidateOutstandingForUser(
    userId: string,
    usedAt: Date,
    exceptTokenId: string,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<number> {
    const result = await client.passwordResetToken.updateMany({
      where: {
        userId,
        id: { not: exceptTokenId },
        usedAt: null,
      },
      data: { usedAt },
    });

    return result.count;
  }
}
