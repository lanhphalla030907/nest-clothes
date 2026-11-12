import { SetMetadata } from '@nestjs/common';

export const AUTH_RATE_LIMIT_METADATA = 'auth_rate_limit';

export interface AuthRateLimitOptions {
  /** Maximum accepted requests in one window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

/**
 * Overrides the auth rate limiter's default budget for one handler.
 *
 * The global default stays the existing 20 requests/minute. Sensitive flows
 * such as password reset narrow it without a second limiter implementation.
 */
export const AuthRateLimit = (options: AuthRateLimitOptions) =>
  SetMetadata(AUTH_RATE_LIMIT_METADATA, options);
