import type { CookieOptions, Response } from 'express';
import {
  REFRESH_CSRF_COOKIE,
  REFRESH_SESSION_COOKIE,
} from './refresh-token.constants.js';

/**
 * One cookie policy shared by login and POST /auth/refresh.
 *
 * The refresh token is HttpOnly; the CSRF token is deliberately readable so
 * the client can echo it in the x-csrf-token header. Both use the same expiry.
 */
export function refreshCookieOptions(expiresAt: Date): CookieOptions {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  };
}

export function csrfCookieOptions(expiresAt: Date): CookieOptions {
  return { ...refreshCookieOptions(expiresAt), httpOnly: false };
}

export function setRefreshCookies(
  response: Response,
  rawRefreshToken: string,
  rawCsrfToken: string,
  expiresAt: Date,
): void {
  response.cookie(
    REFRESH_SESSION_COOKIE,
    rawRefreshToken,
    refreshCookieOptions(expiresAt),
  );
  response.cookie(
    REFRESH_CSRF_COOKIE,
    rawCsrfToken,
    csrfCookieOptions(expiresAt),
  );
}

export function clearRefreshCookies(response: Response): void {
  response.clearCookie(REFRESH_SESSION_COOKIE, refreshCookieOptions(new Date(0)));
  response.clearCookie(REFRESH_CSRF_COOKIE, csrfCookieOptions(new Date(0)));
}
