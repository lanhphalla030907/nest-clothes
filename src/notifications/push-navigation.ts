/**
 * Navigation route validation for push payloads.
 *
 * Push bodies must remain generic and carry only a validated internal route.
 * Clients fetch protected details via authenticated APIs. Relative in-app
 * paths are allowed; everything else falls back to `/notifications`.
 */

const SAFE_FALLBACK = '/notifications';

/**
 * Validates a navigation URL for inclusion in a push payload.
 *
 * Rules:
 * - Must be a relative path starting with `/`
 * - No protocol-relative URLs (`//…`)
 * - No backslashes
 * - No external URLs or schemes (`javascript:`, `data:`, etc.)
 *
 * Returns the validated path, or `SAFE_FALLBACK` when the input is unsafe.
 */
export const validateNavigationRoute = (url: string | null | undefined): string => {
  if (url === null || url === undefined || url.length === 0) {
    return SAFE_FALLBACK;
  }

  const trimmed = url.trim();

  // Must start with '/'
  if (!trimmed.startsWith('/')) {
    return SAFE_FALLBACK;
  }

  // No protocol-relative URLs
  if (trimmed.startsWith('//')) {
    return SAFE_FALLBACK;
  }

  // No backslashes
  if (trimmed.includes('\\')) {
    return SAFE_FALLBACK;
  }

  // No scheme of any kind (javascript:, data:, etc.) — a relative path has
  // no `:` before the first `/` after the leading one.
  const schemeEnd = trimmed.indexOf(':');
  const firstSlashAfterStart = trimmed.indexOf('/', 1);
  if (
    schemeEnd !== -1 &&
    (firstSlashAfterStart === -1 || schemeEnd < firstSlashAfterStart)
  ) {
    return SAFE_FALLBACK;
  }

  return trimmed;
};

export { SAFE_FALLBACK };
