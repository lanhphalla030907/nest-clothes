/**
 * Canonicalises a stock keeping unit so that uniqueness checks and persistence
 * always operate on the same value.
 *
 * Case is folded and surrounding whitespace is removed, so `  ab-12 ` and
 * `AB-12` are stored — and compared — identically. Internal characters are left
 * untouched: what a merchant considers a valid SKU is a catalogue policy, not
 * something this function should silently rewrite.
 *
 * Normalisation is idempotent, so it is safe to apply both at the request
 * boundary and again in the service layer.
 */
export function normalizeSku(sku: string): string {
  return sku.trim().toUpperCase();
}
