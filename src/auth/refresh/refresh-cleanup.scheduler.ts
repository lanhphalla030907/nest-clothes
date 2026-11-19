import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service.js';
import { REFRESH_PENDING_TTL_MS } from './refresh-token.constants.js';
import { RefreshSessionRepository } from './refresh-session.repository.js';

export const REFRESH_CLEANUP_INTERVAL =
  'refresh-session-and-result-cleanup';
export const REFRESH_CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

@Injectable()
export class RefreshCleanupScheduler {
  private readonly logger = new Logger(RefreshCleanupScheduler.name);
  private running: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: RefreshSessionRepository,
  ) {}

  @Interval(REFRESH_CLEANUP_INTERVAL, REFRESH_CLEANUP_INTERVAL_MS)
  async cleanup(): Promise<void> {
    if (this.running) return;
    this.running = this.execute();
    try {
      await this.running;
    } finally {
      this.running = null;
    }
  }

  private async execute(): Promise<void> {
    const now = new Date();
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '2s'");
        await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '5s'");
        await this.sessions.cleanupExpiredRotationResults(
          now,
          REFRESH_PENDING_TTL_MS,
          tx,
        );
        await this.sessions.deleteExpired(now, tx);
        await this.sessions.cleanupExpiredTombstones(now, tx);
      });
    } catch (error) {
      this.logger.error(
        'Refresh session cleanup failed',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
