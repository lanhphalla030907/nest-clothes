import { BadRequestException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import {
  addCalendarDays,
  formatCalendarDate,
  grossProfitFromKnownCost,
  isCoveragePartial,
  parseCalendarDate,
  resolveFinanceRange,
  serializeMoney,
  serializeNullableMoney,
  serializeRatio,
  startOfReportingDayUtc,
  toDecimal,
  toNullableDecimal,
  todayInReportingTimeZone,
} from './finance.utils.js';

/**
 * Reporting-window and serialisation rules.
 *
 * The date helpers are the only place a calendar label becomes an instant, so
 * these tests pin the half-open boundary and the `Asia/Phnom_Penh` offset
 * directly. The money helpers are tested for the two rules that matter most in
 * this module: money is serialised as an exact string, and a missing cost stays
 * `null` rather than becoming zero.
 */
describe('finance date helpers', () => {
  it('parses real calendar dates and rejects malformed or impossible ones', () => {
    expect(parseCalendarDate('2026-09-30').toISOString()).toBe(
      '2026-09-30T00:00:00.000Z',
    );
    expect(parseCalendarDate('2028-02-29').toISOString()).toBe(
      '2028-02-29T00:00:00.000Z',
    );

    for (const value of ['2026-9-30', '30-09-2026', '2026-02-30', 'nope']) {
      expect(() => parseCalendarDate(value)).toThrow(BadRequestException);
    }
  });

  it('adds calendar days across month and year boundaries', () => {
    expect(addCalendarDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addCalendarDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addCalendarDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('formats a UTC instant as its calendar label', () => {
    expect(formatCalendarDate(new Date('2026-09-30T16:59:59.999Z'))).toBe(
      '2026-09-30',
    );
  });

  it('starts a reporting day seven hours before UTC midnight', () => {
    expect(startOfReportingDayUtc('2026-09-30').toISOString()).toBe(
      '2026-09-29T17:00:00.000Z',
    );
    expect(startOfReportingDayUtc('2026-10-01').toISOString()).toBe(
      '2026-09-30T17:00:00.000Z',
    );
  });

  it('reads today from the reporting timezone, not the host clock', () => {
    expect(todayInReportingTimeZone(new Date('2026-09-30T16:59:59.999Z'))).toBe(
      '2026-09-30',
    );
    expect(todayInReportingTimeZone(new Date('2026-09-30T17:00:00.000Z'))).toBe(
      '2026-10-01',
    );
  });
});

describe('resolveFinanceRange', () => {
  it('defaults to the last 30 reporting days ending today', () => {
    const range = resolveFinanceRange({
      to: '2026-09-30',
    });

    expect(range).toEqual({
      from: '2026-09-01',
      to: '2026-09-30',
      fromUtc: new Date('2026-08-31T17:00:00.000Z'),
      toExclusiveUtc: new Date('2026-09-30T17:00:00.000Z'),
      basis: 'delivered',
      timezone: 'Asia/Phnom_Penh',
      currency: undefined,
    });
  });

  it('turns an inclusive day range into a half-open UTC window', () => {
    const range = resolveFinanceRange({
      from: '2026-09-30',
      to: '2026-09-30',
      basis: 'booked',
      currency: ' usd ',
    });

    expect(range.fromUtc.toISOString()).toBe('2026-09-29T17:00:00.000Z');
    expect(range.toExclusiveUtc.toISOString()).toBe('2026-09-30T17:00:00.000Z');
    expect(range.toExclusiveUtc.getTime() - range.fromUtc.getTime()).toBe(
      24 * 60 * 60 * 1000,
    );
    expect(range.basis).toBe('booked');
    expect(range.currency).toBe('USD');
  });

  it('rejects inverted, oversized and invalid ranges', () => {
    expect(() =>
      resolveFinanceRange({ from: '2026-09-30', to: '2026-09-01' }),
    ).toThrow(BadRequestException);

    expect(() =>
      resolveFinanceRange({ from: '2025-01-01', to: '2026-12-31' }),
    ).toThrow(/must not exceed 366 days/);

    expect(() =>
      resolveFinanceRange({ from: '2026-09-01', to: '2026-09-30', basis: 'x' }),
    ).toThrow(/basis must be delivered or booked/);

    expect(() =>
      resolveFinanceRange({ from: '2026-09-01', to: '2026-02-31' }),
    ).toThrow(BadRequestException);
  });
});

describe('finance money helpers', () => {
  it('serialises money as fixed two-decimal strings', () => {
    expect(serializeMoney('1')).toBe('1.00');
    expect(serializeMoney(new Prisma.Decimal('12.345'))).toBe('12.35');
    expect(serializeMoney(null)).toBe('0.00');
    expect(serializeNullableMoney(null)).toBeNull();
    expect(serializeNullableMoney('0')).toBe('0.00');
  });

  it('never invents a ratio when the denominator is missing or zero', () => {
    expect(serializeRatio('1', '3')).toBe('0.3333');
    expect(serializeRatio('1', '0')).toBeNull();
    expect(serializeRatio(null, '3')).toBeNull();
    expect(serializeRatio('0', null)).toBeNull();
  });

  it('treats absent or sub-100% coverage as partial', () => {
    expect(isCoveragePartial(null)).toBe(true);
    expect(isCoveragePartial('0.9999')).toBe(true);
    expect(isCoveragePartial('1.0000')).toBe(false);
  });

  it('keeps missing cost unknown instead of zero', () => {
    expect(grossProfitFromKnownCost('100.00', null)).toBeNull();
    expect(grossProfitFromKnownCost('100.00', '30.00')).toBe('70.00');
    expect(grossProfitFromKnownCost('100.00', '130.00')).toBe('-30.00');
  });

  it('converts database values to exact decimals', () => {
    expect(toDecimal(undefined).toFixed(2)).toBe('0.00');
    expect(toDecimal('2.50').toFixed(2)).toBe('2.50');
    expect(toNullableDecimal(null)).toBeNull();
    expect(toNullableDecimal('2.50')?.toFixed(2)).toBe('2.50');
  });
});
