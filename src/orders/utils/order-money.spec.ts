import { Prisma } from '../../generated/prisma/client.js';
import {
  calculateLineTotal,
  calculateOrderTotal,
  InvalidMoneyValueError,
  sumLineTotals,
  toNonNegativeDecimal,
} from './order-money.js';

/**
 * The money rules every order figure passes through.
 *
 * The point of this file is that **no float ever touches an amount**. Each test
 * uses a value chosen because a float gets it wrong — `0.1 + 0.2`, `19.99 * 3` —
 * so a regression that reintroduced arithmetic on `number` would fail here rather
 * than in production, where it would surface as a total that disagrees with the
 * sum of its own lines by a fraction of a penny.
 */
describe('order money', () => {
  describe('toNonNegativeDecimal', () => {
    it('parses a decimal string exactly', () => {
      expect(toNonNegativeDecimal('19.99', 'unitPrice').toFixed(2)).toBe(
        '19.99',
      );
    });

    it('parses a number without ever doing arithmetic on it', () => {
      expect(toNonNegativeDecimal(0.1, 'unitPrice').toFixed(2)).toBe('0.10');
    });

    it('accepts a Decimal unchanged', () => {
      const decimal = new Prisma.Decimal('7.25');

      expect(toNonNegativeDecimal(decimal, 'shippingFee').equals(decimal)).toBe(
        true,
      );
    });

    it('accepts zero, which is a legitimate free-shipping or no-discount value', () => {
      expect(toNonNegativeDecimal('0', 'shippingFee').isZero()).toBe(true);
      expect(toNonNegativeDecimal(0, 'shippingFee').isZero()).toBe(true);
    });

    it('keeps a value with more than two decimals rather than rounding it away', () => {
      // Rounding here would silently change what the customer is charged; the
      // database column is where a scale of 2 is enforced.
      expect(toNonNegativeDecimal('19.999', 'unitPrice').toFixed(3)).toBe(
        '19.999',
      );
    });

    it.each([
      ['a negative string', '-0.01'],
      ['a negative number', -1],
    ])('rejects %s', (_label, value) => {
      expect(() => toNonNegativeDecimal(value, 'totalAmount')).toThrow(
        InvalidMoneyValueError,
      );
    });

    it('treats negative zero as zero, exactly as the CHECK constraint does', () => {
      // `-0 >= 0` is true in PostgreSQL, so refusing it here would make the
      // service stricter than the database for no benefit.
      expect(toNonNegativeDecimal(-0, 'shippingFee').isZero()).toBe(true);
      expect(toNonNegativeDecimal('-0.00', 'shippingFee').isZero()).toBe(true);
    });

    it.each([
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
      ['an unparseable string', 'free'],
      ['null', null],
      ['undefined', undefined],
      ['an empty string', ''],
      ['an object', {}],
    ])('rejects %s', (_label, value) => {
      expect(() => toNonNegativeDecimal(value, 'subtotal')).toThrow(
        InvalidMoneyValueError,
      );
    });

    it('names the offending field, so a 400 can say which one', () => {
      expect(() => toNonNegativeDecimal('-1.00', 'discountAmount')).toThrow(
        /discountAmount/,
      );
    });
  });

  describe('calculateLineTotal', () => {
    it('multiplies exactly, where a float would not', () => {
      // 0.1 + 0.2 !== 0.3 in binary floating point.
      expect(calculateLineTotal('0.10', 3).toFixed(2)).toBe('0.30');
      // 19.99 * 3 is 59.97000000000001 as a float.
      expect(calculateLineTotal('19.99', 3).toFixed(2)).toBe('59.97');
    });

    it('multiplies a single unit without changing it', () => {
      expect(calculateLineTotal('129.00', 1).toFixed(2)).toBe('129.00');
    });

    it('handles a large quantity without drift', () => {
      expect(calculateLineTotal('0.07', 100000).toFixed(2)).toBe('7000.00');
    });

    it('returns a Decimal, so the caller cannot reintroduce a float', () => {
      expect(calculateLineTotal('1.00', 2)).toBeInstanceOf(Prisma.Decimal);
    });

    it.each([
      ['zero', 0],
      ['a negative quantity', -1],
      ['a fractional quantity', 1.5],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
    ])('rejects %s', (_label, quantity) => {
      expect(() => calculateLineTotal('10.00', quantity)).toThrow(
        InvalidMoneyValueError,
      );
    });

    it('rejects a fractional quantity before it can reach the database', () => {
      // The column is INTEGER, so this must never be relied upon to fail there.
      expect(() => calculateLineTotal('10.00', 2.0000001)).toThrow(
        InvalidMoneyValueError,
      );
    });

    it('rejects a free line: zero is not a price', () => {
      expect(() => calculateLineTotal('0.00', 1)).toThrow(
        InvalidMoneyValueError,
      );
    });

    it('rejects a negative unit price', () => {
      expect(() => calculateLineTotal('-10.00', 1)).toThrow(
        InvalidMoneyValueError,
      );
    });
  });

  describe('calculateOrderTotal', () => {
    it('adds shipping and subtracts the discount, exactly', () => {
      expect(
        calculateOrderTotal('129.00', '7.50', '8.00').toFixed(2),
      ).toBe('128.50');
    });

    it('is unaffected by float error in its inputs', () => {
      // 0.1 + 0.2 !== 0.3 as floats; as decimals it is exactly 0.30.
      expect(
        calculateOrderTotal('0.10', '0.20', '0.00').toFixed(2),
      ).toBe('0.30');
    });

    it('accepts a zero shipping fee and a zero discount', () => {
      expect(calculateOrderTotal('50.00', '0.00', '0.00').toFixed(2)).toBe(
        '50.00',
      );
    });

    it('accepts a discount that exactly cancels the goods', () => {
      expect(calculateOrderTotal('50.00', '0.00', '50.00').toFixed(2)).toBe(
        '0.00',
      );
    });

    it('refuses a discount larger than the goods rather than clamping it', () => {
      // Clamping would charge a different amount than the arithmetic implies.
      expect(() => calculateOrderTotal('50.00', '0.00', '50.01')).toThrow(
        InvalidMoneyValueError,
      );
      expect(() => calculateOrderTotal('50.00', '0.00', '60.00')).toThrow(
        /totalAmount/,
      );
    });

    it('refuses negative components, naming each one', () => {
      expect(() => calculateOrderTotal('-1.00', '0.00', '0.00')).toThrow(
        /subtotal/,
      );
      expect(() => calculateOrderTotal('1.00', '-1.00', '0.00')).toThrow(
        /shippingFee/,
      );
      expect(() => calculateOrderTotal('1.00', '0.00', '-1.00')).toThrow(
        /discountAmount/,
      );
    });
  });

  describe('sumLineTotals', () => {
    it('sums an empty list to zero', () => {
      expect(sumLineTotals([]).toFixed(2)).toBe('0.00');
    });

    it('sums many lines without float drift', () => {
      // 0.01 added a hundred times is 0.9999999999999999 in floating point.
      const lines = Array.from({ length: 100 }, () => '0.01');

      expect(sumLineTotals(lines).toFixed(2)).toBe('1.00');
    });

    it('sums a realistic basket exactly', () => {
      expect(
        sumLineTotals(['129.00', '59.97', '19.99', '0.03']).toFixed(2),
      ).toBe('208.99');
    });

    it('accepts Decimals and strings alike', () => {
      expect(
        sumLineTotals([new Prisma.Decimal('1.50'), '2.50', 3]).toFixed(2),
      ).toBe('7.00');
    });

    it('refuses a negative line, so a subtotal cannot be quietly reduced', () => {
      expect(() => sumLineTotals(['10.00', '-1.00'])).toThrow(
        InvalidMoneyValueError,
      );
    });
  });

  it('agrees with the database identity the migration enforces', () => {
    // The CHECK constraint in the migration is `total = subtotal + shippingFee -
    // discountAmount`; this pins the service's arithmetic to the same identity, so
    // a valid order can never be one the database rejects.
    const unitPrice = '19.99';
    const quantity = 3;
    const lineTotal = calculateLineTotal(unitPrice, quantity);
    const subtotal = sumLineTotals([lineTotal]);
    const total = calculateOrderTotal(subtotal, '4.99', '2.49');

    expect(lineTotal.toFixed(2)).toBe('59.97');
    expect(subtotal.toFixed(2)).toBe('59.97');
    expect(total.toFixed(2)).toBe('62.47');
    expect(
      total.equals(subtotal.plus('4.99').minus('2.49')),
    ).toBe(true);
  });
});
