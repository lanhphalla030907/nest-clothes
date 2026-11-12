/**
 * Messages that are safe to return to an unauthenticated caller.
 *
 * The request message is deliberately identical for a known and an unknown
 * email address. The reset failure message is identical for an invalid,
 * expired, already-used and concurrently-consumed token.
 */
export const PASSWORD_RESET_REQUEST_MESSAGE =
  'If an account exists for that email, a password reset link has been sent.';

export const PASSWORD_RESET_SUCCESS_MESSAGE =
  'Your password has been reset. You can now sign in with your new password.';

export const INVALID_PASSWORD_RESET_TOKEN_MESSAGE =
  'This password reset link is invalid or has expired. Request a new one.';

export const PASSWORD_RESET_TEMPORARILY_UNAVAILABLE_MESSAGE =
  'Password reset is temporarily unavailable. Please try again later.';

/** How long a reset link remains valid. */
export const PASSWORD_RESET_TOKEN_TTL_MS = 15 * 60 * 1000;

export const PASSWORD_RESET_TOKEN_TTL_MINUTES = 15;

/** 32 random bytes, base64url encoded: 43 characters, 256 bits of entropy. */
export const PASSWORD_RESET_TOKEN_BYTES = 32;
