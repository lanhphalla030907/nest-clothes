/**
 * Canonicalises an email address so that uniqueness checks and persistence
 * always operate on the same value.
 *
 * Normalisation is idempotent, so it is safe to apply both at the request
 * boundary and again in the service layer.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}