import { Module } from '@nestjs/common';
import { JwtAuthModule } from '../auth/jwt/jwt-auth.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsRepository } from './notifications.repository.js';
import { NotificationsService } from './notifications.service.js';
import { TelegramOrderAlertsService } from './telegram/telegram-order-alerts.service.js';
import { readTelegramSettings, TELEGRAM_SETTINGS } from './telegram/telegram.config.js';
import { TelegramService } from './telegram/telegram.service.js';

/**
 * Owns in-app notifications and the Telegram order-alert outbox.
 *
 * `JwtAuthModule` is imported for `JwtAuthGuard`, which the shared notification
 * controller mounts on all five routes. `PrismaModule` is `@Global`, so the
 * explicit import is redundant but keeps the repository's dependency visible.
 *
 * `NotificationsService` is exported because the features that own an event — the
 * checkout, the orders, the payments, the delivery and the inventory — call its
 * `notify*` handlers *after* their own transaction commits. They inject the service
 * rather than the repository so the audience fan-out, the dedupe keys and the
 * fire-and-forget error handling stay in exactly one place. `TelegramOrderAlertsService`
 * is re-exported unchanged for the same post-commit reason.
 */
@Module({
  imports: [PrismaModule, JwtAuthModule],
  controllers: [NotificationsController],
  providers: [
    NotificationsRepository,
    NotificationsService,
    {
      provide: TELEGRAM_SETTINGS,
      useFactory: readTelegramSettings,
    },
    TelegramService,
    TelegramOrderAlertsService,
  ],
  exports: [NotificationsService, TelegramOrderAlertsService],
})
export class NotificationsModule {}

