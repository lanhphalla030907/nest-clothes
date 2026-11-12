import { Module } from '@nestjs/common';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import {
  MAIL_CONFIG,
  MAIL_TRANSPORTER,
  readMailConfig,
  type ResolvedMailConfig,
} from './email.config.js';
import { EmailService } from './email.service.js';

const mailConfigProvider = {
  provide: MAIL_CONFIG,
  useFactory: (): ResolvedMailConfig => readMailConfig(),
};

/**
 * Builds the SMTP transport once, when the application boots.
 *
 * `null` is a valid value: no credentials means "email is unavailable", which
 * the reset endpoint reports as a 503 rather than pretending a message was
 * sent.
 */
const mailTransporterProvider = {
  provide: MAIL_TRANSPORTER,
  inject: [MAIL_CONFIG],
  useFactory: (config: ResolvedMailConfig): Transporter | null => {
    if (!config.configured) {
      return null;
    }

    return nodemailer.createTransport({
      host: config.settings.host,
      port: config.settings.port,
      secure: config.settings.secure,
      auth: {
        user: config.settings.user,
        pass: config.settings.password,
      },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  },
};

/**
 * Owns transactional email. Not global: only the features that actually send a
 * message should be able to reach the SMTP transport.
 */
@Module({
  providers: [mailConfigProvider, mailTransporterProvider, EmailService],
  exports: [EmailService],
})
export class EmailModule {}
