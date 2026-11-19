import { isIP } from 'node:net';
import type { ThrottlerModuleOptions } from '@nestjs/throttler';

export const RATE_LIMIT_POLICIES = {
  baseline: { name: 'default', limit: 100, ttl: 60_000 },
  login: { name: 'login', limit: 5, ttl: 60_000 },
  googleLogin: { name: 'googleLogin', limit: 10, ttl: 60_000 },
  registration: { name: 'registration', limit: 5, ttl: 60 * 60_000 },
  forgotPassword: { name: 'forgotPassword', limit: 3, ttl: 15 * 60_000 },
  resetPassword: { name: 'resetPassword', limit: 5, ttl: 15 * 60_000 },
  checkoutQuote: { name: 'checkoutQuote', limit: 20, ttl: 60_000 },
  orderCreation: { name: 'orderCreation', limit: 10, ttl: 60_000 },
} as const;

export function createThrottlerOptions(): ThrottlerModuleOptions {
  // Only the baseline limiter is registered globally. Per-endpoint policies are
  // applied as @Throttle({ default: ... }) overrides on their own handlers, so
  // unrelated routes do not inherit restrictive limits such as 3/15m or 5/60s.
  // This is in-process storage by default. It is correct for the current
  // single-instance deployment; multi-instance deployments require shared
  // storage such as Redis so counters are not divided between processes.
  return {
    throttlers: [
      {
        name: RATE_LIMIT_POLICIES.baseline.name,
        limit: RATE_LIMIT_POLICIES.baseline.limit,
        ttl: RATE_LIMIT_POLICIES.baseline.ttl,
      },
    ],
  };
}

export function parseTrustedProxySetting(
  value: string | undefined,
): false | string {
  if (!value?.trim()) {
    return false;
  }

  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  const validEntries = entries.filter((entry) => {
    if (isIP(entry)) {
      return true;
    }

    const slash = entry.lastIndexOf('/');
    if (slash <= 0) {
      return false;
    }

    const address = entry.slice(0, slash);
    const prefix = Number(entry.slice(slash + 1));
    if (!isIP(address) || !Number.isInteger(prefix)) {
      return false;
    }

    const addressType = isIP(address);
    return addressType === 4 ? prefix >= 0 && prefix <= 32 : prefix >= 0 && prefix <= 128;
  });

  return validEntries.length === entries.length && validEntries.length > 0
    ? validEntries.join(',')
    : false;
}
