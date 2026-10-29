/**
 * Canonicalises a provider code so uniqueness checks and persistence use the
 * same value. The DTO validates the resulting uppercase code shape.
 */
export function normalizeShippingProviderCode(code: string): string {
  return code.trim().toUpperCase();
}
