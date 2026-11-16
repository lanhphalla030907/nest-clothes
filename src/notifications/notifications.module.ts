import { Module } from '@nestjs/common';
import { JwtAuthModule } from '../auth/jwt/jwt-auth.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsRepository } from './notifications.repository.js';
import { NotificationsService } from './notifications.service.js';
import { TelegramOrderAlertsService } from './telegram/telegram-order-alerts.service.js';
import { readTelegramSettings, TELEGRAM_SETTINGS } from './telegram/telegram.config.js';
import { TelegramService } from './telegram/telegram.service.js';
import { PushSubscriptionController } from './push-subscription.controller.js';
import { PushSubscriptionRepository } from './push-subscription.repository.js';
import { PushDeliveryRepository } from './push-delivery.repository.js';
import { PushSubscriptionService } from './push-subscription.service.js';
import { PushEnqueueService } from './push-enqueue.service.js';
import { readVapidSettings, VAPID_SETTINGS } from './vapid/vapid.config.js';
import { PushDeliveryWorker } from './push-delivery.worker.js';
import { readPushWorkerConfig } from './push-worker.config.js';

const PUSH_WORKER_CONFIG = 'PUSH_WORKER_CONFIG';

/**
 * Owns in-app notifications, Telegram order-alert outbox, and Web Push
 * subscription management plus delivery enqueue.
 *
 * Phase 2B additions: `PushSubscriptionController`, `PushSubscriptionService`,
 * `PushDeliveryRepository`, `PushEnqueueService`, and VAPID configuration.
 * Phase 1 notifications and Telegram behaviour are unchanged.
 */
@Module({
  imports: [PrismaModule, JwtAuthModule],
  controllers: [NotificationsController, PushSubscriptionController],
  providers: [
    NotificationsRepository,
    NotificationsService,
    {
      provide: TELEGRAM_SETTINGS,
      useFactory: readTelegramSettings,
    },
    TelegramService,
    TelegramOrderAlertsService,
    {
      provide: VAPID_SETTINGS,
      useFactory: readVapidSettings,
    },
    PushSubscriptionRepository,
    PushDeliveryRepository,
    PushSubscriptionService,
    PushEnqueueService,
    PushDeliveryWorker,
    {
      provide: PUSH_WORKER_CONFIG,
      useFactory: readPushWorkerConfig,
    },
  ],
  exports: [NotificationsService, TelegramOrderAlertsService, PushEnqueueService],
})
export class NotificationsModule {}
