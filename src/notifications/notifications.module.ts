import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { NotificationsRepository } from './notifications.repository.js';
import { TelegramOrderAlertsService } from './telegram/telegram-order-alerts.service.js';
import { readTelegramSettings, TELEGRAM_SETTINGS } from './telegram/telegram.config.js';
import { TelegramService } from './telegram/telegram.service.js';

@Module({
  imports: [PrismaModule],
  providers: [
    NotificationsRepository,
    {
      provide: TELEGRAM_SETTINGS,
      useFactory: readTelegramSettings,
    },
    TelegramService,
    TelegramOrderAlertsService,
  ],
  exports: [TelegramOrderAlertsService],
})
export class NotificationsModule {}

