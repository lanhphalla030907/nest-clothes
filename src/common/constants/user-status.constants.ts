/**
 * Canonical value of `users.status` for a user allowed to authenticate.
 *
 * `users.status` is a free-form column rather than a Prisma enum, so the
 * active value is centralised here. Every service that writes or evaluates the
 * column must import this constant instead of repeating the literal.
 */
export const ACTIVE_USER_STATUS = 'ACTIVE';
