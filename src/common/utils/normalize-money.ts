/**
 * Accepted input shape: a non-negative decimal with at most two fraction
 * digits. The fractional group is optional so `"19"` and `"19.9"` are valid
 * input, not errors.
 */
const DECIMAL_INPUT_PATTERN = /^(\d+)(?:\.(\d{1,2}))?$/;

/**
 * Canonicalises a monetary amount to a plain decimal string carrying exactly
 * two fraction digits — the form `Decimal(12,2)` stores.
 *
 * A string is returned rather than a number on purpose. IEEE-754 doubles cannot
 * represent every two-decimal value exactly, so a JSON number would let a
 * client round `19.99` into something else on the way back out. A string keeps
 * the amount byte-identical between request, database and response.
 *
 * Numeric input is rounded to the nearest cent by `toFixed(2)`, which is the
 * same rounding the column itself would apply. Over-detecting sub-cent noise in
 * a float is not possible (`19.99` is already stored as `19.98999…`), so the
 * conversion is explicit rather than a silent truncation.
 *
 * Values that cannot be interpreted as money — negatives, `"abc"`, `NaN`,
 * magnitudes past the column precision — are returned **unchanged** so that the
 * DTO validators, not this function, produce the client-facing error.
 *
 * Normalisation is idempotent, so it is safe to apply both at the request
 * boundary and again in the service layer.
 */
export function normalizeMoney(value: string | number): string;
export function normalizeMoney(value: unknown): unknown;
export function normalizeMoney(value: unknown): unknown {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value.toFixed(2) : value;
  }

  if (typeof value !== 'string') {
    return value;
  }

  const match = DECIMAL_INPUT_PATTERN.exec(value.trim());

  if (match === null) {
    return value;
  }

  return `${match[1]}.${(match[2] ?? '').padEnd(2, '0')}`;
}