import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Transporter } from 'nodemailer';
import {
  MAIL_CONFIG,
  MAIL_TRANSPORTER,
  type ResolvedMailConfig,
} from './email.config.js';
import { renderPasswordResetEmail } from './password-reset-email.template.js';

export class EmailNotConfiguredError extends Error {
  constructor() {
    super('Email delivery is not configured');
    this.name = 'EmailNotConfiguredError';
  }
}

export class EmailDeliveryError extends Error {
  constructor() {
    super('Email delivery failed');
    this.name = 'EmailDeliveryError';
  }
}

export interface SendPasswordResetInput {
  to: string;
  firstName: string;
  /** Raw single-use token. Never logged and never persisted by this service. */
  token: string;
  expiresInMinutes: number;
}

/**
 * Transactional email over SMTP.
 *
 * The token is used only to build the link in the message body. Nothing here
 * logs the token, the recipient or the SMTP credentials; a delivery failure is
 * reduced to a generic message before it leaves the layer.
 */
@Injectable()
export class EmailService {
  readonly #logger = new Logger(EmailService.name);
  readonly #config: ResolvedMailConfig;
  readonly #transporter: Transporter | null;

  constructor(
    @Inject(MAIL_CONFIG) config: ResolvedMailConfig,
    @Inject(MAIL_TRANSPORTER) transporter: Transporter | null,
  ) {
    this.#config = config;
    this.#transporter = transporter;
  }

  get isConfigured(): boolean {
    return this.#config.configured && this.#transporter !== null;
  }

  /**
   * @throws {EmailNotConfiguredError} when SMTP settings are absent/incomplete.
   * @throws {EmailDeliveryError} when the provider rejects the message.
   */
  async sendPasswordReset(input: SendPasswordResetInput): Promise<void> {
    if (!this.#config.configured || this.#transporter === null) {
      throw new EmailNotConfiguredError();
    }

    const resetUrl = this.buildResetUrl(
      this.#config.settings.resetUrl,
      input.token,
    );
    const rendered = renderPasswordResetEmail({
      firstName: input.firstName,
      resetUrl,
      expiresInMinutes: input.expiresInMinutes,
    });

    try {
      await this.#transporter.sendMail({
        from: this.#config.settings.from,
        to: input.to,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'UnknownError';
      this.#logger.error(
        `Password reset email delivery failed (${reason}). Check the SMTP configuration and provider status.`,
      );
      throw new EmailDeliveryError();
    }
  }

  private buildResetUrl(baseUrl: string, token: string): string {
    const url = new URL(baseUrl);
    url.searchParams.set('token', token);
    return url.toString();
  }
}
