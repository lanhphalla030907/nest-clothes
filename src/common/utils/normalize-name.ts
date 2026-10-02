/**
 * Trims a display name and collapses every internal run of whitespace into a
 * single space, so `  Oversized   T-Shirt  ` and `Oversized T-Shirt` are stored
 * identically.
 *
 * Shared by every catalog entity that has a human-facing name.
 *
 * Normalisation is idempotent, so it is safe to apply both at the request
 * boundary and again in the service layer.
 */
export function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}