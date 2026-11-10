import { BadRequestException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { toMoneyString } from '../orders/utils/order-money.js';
import {
  FINANCE_DEFAULT_BASIS,
  FINANCE_DEFAULT_RANGE_DAYS,
  FINANCE_MAX_RANGE_DAYS,
  FINANCE_REPORTING_TIMEZONE,
  FINANCE_REPORTING_UTC_OFFSET_MINUTES,
  type FinanceBasis,
} from './finance.constants.js';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const REPORTING_OFFSET_MS = FINANCE_REPORTING_UTC_OFFSET_MINUTES * 60 * 1000;

/** A resolved, half-open reporting window. */
export interface ResolvedFinanceRange {
  /** First reporting date, inclusive, as `YYYY-MM-DD`. */
  from: string;
  /** Last reporting date, inclusive, as `YYYY-MM-DD`. */
  to: string;
  /** `from` at 00:00 in the reporting timezone, as a UTC instant. */
  fromUtc: Date;
  /** The day after `to` at 00:00 in the reporting timezone, as a UTC instant. */
  toExclusiveUtc: Date;
  basis: FinanceBasis;
  timezone: string;
  /** Upper-case ISO 4217 code, or undefined for "all currencies". */
  currency?: string;
}

/** The caller-supplied part of a reporting window. */
export interface FinanceRangeInput {
  from?: string;
  to?: string;
  basis?: FinanceBasis | string;
  currency?: string;
}

/**
 * Parses a calendar date as a UTC midnight instant.
 *
 * A calendar date is a label, not an instant. Parsing it in UTC here keeps the
 * arithmetic independent of the host timezone; {@link startOfReportingDayUtc}
 * is the function that turns the label into the real instant a reporting day
 * begins.
 */
export function parseCalendarDate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new BadRequestException('date must be in YYYY-MM-DD format');
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new BadRequestException(`"${value}" is not a real calendar date`);
  }

  return parsed;
}

/** Formats a date as `YYYY-MM-DD` using its UTC calendar fields. */
export function formatCalendarDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** Adds whole calendar days to a `YYYY-MM-DD` date. */
export function addCalendarDays(value: string, days: number): string {
  const date = parseCalendarDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return formatCalendarDate(date);
}

/**
 * The UTC instant at which a reporting day begins.
 *
 * `Asia/Phnom_Penh` is a fixed UTC+7 offset, so the local midnight is seven hours
 * before the UTC midnight of the same calendar label.
 */
export function startOfReportingDayUtc(value: string): Date {
  return new Date(parseCalendarDate(value).getTime() - REPORTING_OFFSET_MS);
}

/** Today's calendar date in the reporting timezone. */
export function todayInReportingTimeZone(now: Date = new Date()): string {
  return formatCalendarDate(new Date(now.getTime() + REPORTING_OFFSET_MS));
}

/**
 * Resolves and validates a reporting window.
 *
 * The returned window is half-open in UTC: `[fromUtc, toExclusiveUtc)`. The
 * inclusive `to` label is converted by advancing one reporting day, so a
 * request for a single day is exactly 24 hours and cannot accidentally include
 * the first instant of the next day.
 */
export function resolveFinanceRange(
  input: FinanceRangeInput = {},
): ResolvedFinanceRange {
  const to = input.to ?? todayInReportingTimeZone();
  const from =
    input.from ?? addCalendarDays(to, -(FINANCE_DEFAULT_RANGE_DAYS - 1));

  const fromCalendar = parseCalendarDate(from);
  const toCalendar = parseCalendarDate(to);

  if (fromCalendar.getTime() > toCalendar.getTime()) {
    throw new BadRequestException('from must not be after to');
  }

  const inclusiveDays =
    Math.floor(
      (toCalendar.getTime() - fromCalendar.getTime()) / MILLISECONDS_PER_DAY,
    ) + 1;

  if (inclusiveDays > FINANCE_MAX_RANGE_DAYS) {
    throw new BadRequestException(
      `reporting range must not exceed ${FINANCE_MAX_RANGE_DAYS} days`,
    );
  }

  const basis = (input.basis ?? FINANCE_DEFAULT_BASIS) as FinanceBasis;
  if (basis !== 'delivered' && basis !== 'booked') {
    throw new BadRequestException('basis must be delivered or booked');
  }

  return {
    from,
    to,
    fromUtc: startOfReportingDayUtc(from),
    toExclusiveUtc: startOfReportingDayUtc(addCalendarDays(to, 1)),
    basis,
    timezone: FINANCE_REPORTING_TIMEZONE,
    currency: input.currency?.trim().toUpperCase() || undefined,
  };
}

/** Converts a database value to an exact `Decimal`. */
export function toDecimal(value: unknown): Prisma.Decimal {
  if (value === null || value === undefined) {
    return new Prisma.Decimal(0);
  }
  return value instanceof Prisma.Decimal
    ? value
    : new Prisma.Decimal(String(value));
}

/** Converts a nullable database value to an exact `Decimal` or `null`. */
export function toNullableDecimal(value: unknown): Prisma.Decimal | null {
  return value === null || value === undefined ? null : toDecimal(value);
}

/** Serialises a money value as the fixed two-decimal string the API returns. */
export function serializeMoney(value: unknown): string {
  return toMoneyString(value ?? 0);
}

/** Serialises a nullable money value, preserving "unknown" as `null`. */
export function serializeNullableMoney(value: unknown): string | null {
  return value === null || value === undefined ? null : toMoneyString(value);
}

/**
 * Serialises a ratio to four decimal places.
 *
 * A ratio is not money, so it is not forced to two decimals, but it is still a
 * string at the boundary: a client should never receive a JSON float that it
 * might then use for arithmetic.
 */
export function serializeRatio(
  numerator: unknown,
  denominator: unknown,
): string | null {
  const top = toNullableDecimal(numerator);
  const bottom = toNullableDecimal(denominator);

  if (top === null || bottom === null || bottom.isZero()) {
    return null;
  }

  return top.div(bottom).toDecimalPlaces(4).toFixed(4);
}

/** True when a coverage ratio is absent or below 100%. */
export function isCoveragePartial(coverage: string | null): boolean {
  return coverage === null || new Prisma.Decimal(coverage).lt(1);
}

/**
 * Gross profit over known-cost revenue only.
 *
 * Missing cost is never zero. When no line in the set has a comparable cost
 * snapshot, COGS is `null` and profit is unknown, not the whole revenue.
 */
export function grossProfitFromKnownCost(
  knownCostNetRevenue: unknown,
  cogs: unknown,
): string | null {
  const cost = toNullableDecimal(cogs);
  if (cost === null) {
    return null;
  }
  return toDecimal(knownCostNetRevenue).minus(cost).toFixed(2);
}
