/**
 * Sanitizes an order number for use as a PDF filename.
 *
 * Rejects path separators, null bytes and any character that is not a letter,
 * digit, hyphen or underscore. Falls back to "receipt" when the input is empty
 * or consists entirely of disallowed characters.
 */
export function sanitizeFilename(orderNumber: string): string {
  const sanitized = orderNumber.replace(/[^A-Za-z0-9._-]/g, '_');

  if (sanitized.length === 0 || /^[._-]+$/.test(sanitized)) {
    return 'receipt';
  }

  return sanitized;
}
