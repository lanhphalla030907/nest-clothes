import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { ORDER_STATUS } from '../../orders/constants/order-status.constants.js';

/** ISO 4217 alphabetic code, matching the shape check on `orders.currency`. */
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** Columns an administrator may sort the reconciliation listing by. */
const COD_RECONCILIATION_SORT_BY = [
  'collectedAt',
  'collectedAmount',
  'currency',
  'id',
  'orderNumber',
] as const;
export type CodReconciliationSortBy =
  (typeof COD_RECONCILIATION_SORT_BY)[number];

/** Sort direction. */
const COD_RECONCILIATION_SORT_ORDER = ['asc', 'desc'] as const;
export type CodReconciliationSortOrder =
  (typeof COD_RECONCILIATION_SORT_ORDER)[number];

/** Grouping buckets supported by the reconciliation summary endpoint. */
export const COD_RECONCILIATION_PERIODS = [
  'daily',
  'weekly',
  'monthly',
] as const;
export type CodReconciliationPeriod =
  (typeof COD_RECONCILIATION_PERIODS)[number];

/** Treats a blank optional value as absent rather than storing an empty string. */
const toOptionalTrimmed = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

/** Trims and upper-cases a currency before the shape check runs. */
const toCurrencyCode = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

/** Normalises a sort column to the whitelisted set. */
const toSortBy = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' &&
  COD_RECONCILIATION_SORT_BY.includes(value as CodReconciliationSortBy)
    ? value
    : undefined;

/** Normalises a sort direction to `asc` or `desc`. */
const toSortOrder = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' &&
  COD_RECONCILIATION_SORT_ORDER.includes(value as CodReconciliationSortOrder)
    ? value
    : undefined;

/**
 * Query contract for `GET /admin/cod-reconciliation`.
 *
 * Every value arrives as a query string, so each one is coerced and validated
 * before it reaches Prisma. `whitelist` plus `forbidNonWhitelisted` on the
 * global `ValidationPipe` refuses unknown parameters rather than silently
 * ignoring them.
 */
export class AdminCodReconciliationQueryDto {
  /** One-based page number. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  /** Page size, capped so one request cannot ask for the whole table. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  /** Inclusive lower bound on collection/reporting date. */
  @IsOptional()
  @Transform(toOptionalTrimmed)
  @IsISO8601({ strict: true, strictSeparator: true })
  startDate?: string;

  /** Inclusive upper bound on collection/reporting date. */
  @IsOptional()
  @Transform(toOptionalTrimmed)
  @IsISO8601({ strict: true, strictSeparator: true })
  endDate?: string;

  /** Reconcile collections made by this delivery staff member. */
  @IsOptional()
  @Transform(toOptionalTrimmed)
  @IsUUID()
  staffId?: string;

  /** Reconcile collections for this order. */
  @IsOptional()
  @Transform(toOptionalTrimmed)
  @IsUUID()
  orderId?: string;

  /** Matched against the order's customer-facing reference. */
  @IsOptional()
  @Transform(toOptionalTrimmed)
  @IsString()
  orderNumber?: string;

  /** Order lifecycle status to reconcile against. */
  @IsOptional()
  @Transform(toOptionalTrimmed)
  @IsString()
  @IsIn(Object.values(ORDER_STATUS), {
    message: `status must be one of ${Object.values(ORDER_STATUS).join(', ')}`,
  })
  status?: string;

  @IsOptional()
  @Transform(toCurrencyCode)
  @IsString()
  @Matches(CURRENCY_PATTERN, {
    message: 'currency must be a three-letter ISO 4217 code',
  })
  currency?: string;

  @IsOptional()
  @Transform(toSortBy)
  @IsIn(COD_RECONCILIATION_SORT_BY, {
    message: `sortBy must be one of ${COD_RECONCILIATION_SORT_BY.join(', ')}`,
  })
  sortBy?: CodReconciliationSortBy;

  @IsOptional()
  @Transform(toSortOrder)
  @IsIn(COD_RECONCILIATION_SORT_ORDER, {
    message: `sortOrder must be one of ${COD_RECONCILIATION_SORT_ORDER.join(
      ', ',
    )}`,
  })
  sortOrder?: CodReconciliationSortOrder;

  @IsOptional()
  @Transform(({ value }) => (value === '' ? undefined : value))
  @IsIn(COD_RECONCILIATION_PERIODS, {
    message: `period must be one of ${COD_RECONCILIATION_PERIODS.join(', ')}`,
  })
  period?: CodReconciliationPeriod;
}
