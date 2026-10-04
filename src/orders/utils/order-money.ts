import { Prisma } from '../../generated/prisma/client.js';

/**
 * The monetary arithmetic every order figure passes through.
 *
 * `Decimal(12,2)` is a NUMERIC column, not a float, and this module is the only
 * place arithmetic is performed on one. The rules it exists to enforce:
 *
 * - **Nothing is a JavaScript number on the way in or out.** A two-decimal amount
 *   is not always representable as a float — `0.1 + 0.2 !== 0.3` — so a float
 *   anywhere in this path can make a total disagree with the sum of its lines.
 *   `Decimal` does exact base-10 arithmetic, and every value crosses the API
 *   boundary as a two-decimal *string*, matching `common/utils/money.ts`.
 * - **Nothing negative is accepted.** A negative money value is not a discount, it
 *   is a bug or an attack, and it is refused by the service that owns the rule
 *   and independently by a `CHECK` constraint in the database.
 * - **Nothing is computed from a stale read.** The functions here take the values
 *   they are given rather than re-reading them, so a caller cannot accidentally
 *   total a different set of lines than the ones it validated.
 */

/**
 * Raised when a money value is negative.
 *
 * A dedicated error rather than a bare `RangeError` so the caller can distinguish
 * "this input was not acceptable" from "this code is broken", and so the service
 * layer can map it to a deterministic 400 without string-matching messages.
 */
export class InvalidMoneyValueError extends Error {
  constructor(field: string, _value: unknown) {
    super(`${field} must not be negative`);
    this.name = 'InvalidMoneyValueError';
  }
}

/**
 * Parses `value` into a `Decimal`, refusing negatives.
 *
 * Accepts a string, a `Prisma.Decimal` or a `number`, because a figure can reach
 * this code as a DTO string, a Prisma column or a literal in a test fixture.
 * Accepting a number here does not weaken the guarantee: it is converted straight
 * to `Decimal`, so it is used for its exact decimal digits and never for
 * arithmetic.
 *
 * @throws {InvalidMoneyValueError} when the value is not a finite, non-negative
 * decimal — including `NaN`, `Infinity` and an unparseable string.
 */
export function toNonNegativeDecimal(value: unknown, field: string): Prisma.Decimal {
  let parsed: Prisma.Decimal;

  try {
    parsed =
      value instanceof Prisma.Decimal
        ? value
        : new Prisma.Decimal(typeof value === 'number' ? String(value) : (value as string));
  } catch {
    throw new InvalidMoneyValueError(field, value);
  }

  // `isNegative()` is true for a negative *zero*, which decimal.js keeps a sign
  // bit for. `-0.00 >= 0` is true in PostgreSQL, so the `CHECK` constraints accept
  // it and refusing it here would make the service stricter than the database and
  // reject a value the schema permits. A signed zero is therefore accepted as zero.
  if (!parsed.isFinite() || (parsed.isNegative() && !parsed.isZero())) {
    throw new InvalidMoneyValueError(field, value);
  }

  return parsed;
}

/**
 * `unitPrice × quantity`, exactly.
 *
 * The one place a line total is calculated. `quantity` is an integer count, so the
 * result is exact in base 10 and `toFixed(2)` cannot round anything away.
 *
 * @throws {InvalidMoneyValueError} when either input is negative, or when the
 * quantity is not a positive whole number.
 */
export function calculateLineTotal(
  unitPrice: unknown,
  quantity: number,
): Prisma.Decimal {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new InvalidMoneyValueError('quantity', quantity);
  }

  const price = toNonNegativeDecimal(unitPrice, 'unitPrice');

  if (price.isZero()) {
    throw new InvalidMoneyValueError('unitPrice', unitPrice);
  }

  return price.mul(quantity);
}

/**
 * `subtotal + shippingFee - discountAmount`, exactly.
 *
 * The single definition of what an order costs, used both when an order is
 * written and by the tests that assert the `CHECK` constraint holds. Passing the
 * parts in rather than reading the order back means the figure cannot be computed
 * from a different set of columns than the ones being validated.
 *
 * A discount larger than the goods would produce a negative total; that is
 * refused here rather than clamped, because a clamp would silently charge the
 * customer a different amount than the arithmetic implies.
 *
 * @throws {InvalidMoneyValueError} when any component is negative or the result
 * would be.
 */
export function calculateOrderTotal(
  subtotal: unknown,
  shippingFee: unknown,
  discountAmount: unknown,
): Prisma.Decimal {
  const base = toNonNegativeDecimal(subtotal, 'subtotal');
  const shipping = toNonNegativeDecimal(shippingFee, 'shippingFee');
  const discount = toNonNegativeDecimal(discountAmount, 'discountAmount');

  const total = base.plus(shipping).minus(discount);

  if (total.isNegative()) {
    throw new InvalidMoneyValueError('totalAmount', total);
  }

  return total;
}

/**
 * `SUM(lineTotal)` over an order's lines, exactly.
 *
 * The accumulator starts at a `Decimal` zero and every addition goes through
 * `Decimal.plus`, so a long list of lines cannot drift the way a float sum would.
 * An empty list totals to `0.00`, which is a valid subtotal.
 */
export function sumLineTotals(
  lineTotals: ReadonlyArray<unknown>,
): Prisma.Decimal {
  return lineTotals.reduce<Prisma.Decimal>(
    (total, lineTotal) => total.plus(toNonNegativeDecimal(lineTotal, 'lineTotal')),
    new Prisma.Decimal(0),
  );
}

/**
 * Serialises a money value as the fixed two-decimal string the API returns.
 *
 * Delegates to the project-wide {@link toMoneyString} so an order figure and a
 * cart figure are formatted by one implementation and cannot disagree.
 */
export { toMoneyString } from '../../common/utils/money.js';