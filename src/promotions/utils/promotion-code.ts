/**
 * Canonicalises a coupon code to the form stored in `promotions.code`.
 *
 * Codes are case-insensitive to the customer and uppercase in the database. The
 * migration enforces the uppercase half; this function is the application half
 * that makes a lookup such as `save10` find `SAVE10`. Trimming happens here too,
 * because a code typed or pasted with surrounding whitespace is the same code.
 *
 * An empty string becomes `null`: "no code" is a value, not a zero-length code,
 * and the automatic/coupon constraints are written in terms of null.
 */
export function normalizePromotionCode(
  value: string | null | undefined,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.toUpperCase();
}
