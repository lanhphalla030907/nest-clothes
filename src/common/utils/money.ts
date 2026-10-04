import { Prisma } from '../../generated/prisma/client.js';

/**
 * Serialises a `Decimal(12,2)` column as a fixed two-decimal string.
 *
 * A JSON number cannot represent every two-decimal value exactly, so the amount
 * would be able to drift between the database and the client. A string keeps it
 * byte-identical on the way out, which is the same reason
 * `common/utils/normalize-money.ts` produces a string on the way in.
 *
 * The `String(value)` fallback keeps the helper usable with a value that has
 * already been through `normalizeMoney` — a plain string — as well as with a
 * `Decimal` coming straight out of Prisma, so a caller never has to know which
 * of the two it is holding.
 */
export function toMoneyString(value: unknown): string {
  return value instanceof Prisma.Decimal
    ? value.toFixed(2)
    : new Prisma.Decimal(String(value)).toFixed(2);
}

/**
 * Multiplies a two-decimal amount by a whole quantity, staying exact.
 *
 * Used for derived totals such as a cart line's `lineTotal`, where the
 * multiplication must not pass through a floating-point intermediate.
 */
export function multiplyMoney(amount: string, quantity: number): string {
  return new Prisma.Decimal(amount).mul(quantity).toFixed(2);
}
