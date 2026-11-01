import { Transform, Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';

/** ISO 4217 alphabetic code, matching the shape check on `orders.currency`. */
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** Columns an administrator may sort the collection listing by. */
const COD_COLLECTION_SORT_BY = ['collectedAt', 'amount', 'currency', 'id'] as const;
export type CodCollectionSortBy = (typeof COD_COLLECTION_SORT_BY)[number];

/** Sort direction. */
const COD_COLLECTION_SORT_ORDER = ['asc', 'desc'] as const;
export type CodCollectionSortOrder = (typeof COD_COLLECTION_SORT_ORDER)[number];

/** Grouping buckets supported by the collection summary endpoint. */
export const COD_COLLECTION_PERIODS = ['daily', 'weekly', 'monthly'] as const;
export type CodCollectionPeriod = (typeof COD_COLLECTION_PERIODS)[number];

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
  typeof value === 'string' && COD_COLLECTION_SORT_BY.includes(value as CodCollectionSortBy)
    ? value
    : undefined;

/** Normalises a sort direction to `asc` or `desc`. */
const toSortOrder = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' && COD_COLLECTION_SORT_ORDER.includes(value as CodCollectionSortOrder)
    ? value
    : undefined;

/**
 * Query contract for `GET /admin/cod-collections`.
 *
 * Every value arrives as a query string, so each one is coerced and validated
 * before it reaches Prisma. `whitelist` plus `forbidNonWhitelisted` on the
 * global `ValidationPipe` refuses unknown parameters rather than silently
 * ignoring them.
 */
export class AdminCodCollectionsQueryDto {
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

  /** Inclusive lower bound on `cod_collections.collected_at`. */
  @IsOptional()
  @Transform(toOptionalTrimmed)
  @IsDateString()
  startDate?: string;

  /** Inclusive upper bound on `cod_collections.collected_at`. */
  @IsOptional()
  @Transform(toOptionalTrimmed)
  @IsDateString()
  endDate?: string;

  /** Collections made by this delivery staff member. */
  @IsOptional()
  @Transform(toOptionalTrimmed)
  @IsUUID()
  staffId?: string;

  /** Collections for this order. */
  @IsOptional()
  @Transform(toOptionalTrimmed)
  @IsUUID()
  orderId?: string;

  /** Matched against the order's customer-facing reference. */
  @IsOptional()
  @Transform(toOptionalTrimmed)
  @IsString()
  orderNumber?: string;

  @IsOptional()
  @Transform(toCurrencyCode)
  @IsString()
  @Matches(CURRENCY_PATTERN, {
    message: 'currency must be a three-letter ISO 4217 code',
  })
  currency?: string;

  @IsOptional()
  @Transform(toSortBy)
  @IsIn(COD_COLLECTION_SORT_BY, {
    message: `sortBy must be one of ${COD_COLLECTION_SORT_BY.join(', ')}`,
  })
  sortBy?: CodCollectionSortBy;

  @IsOptional()
  @Transform(toSortOrder)
  @IsIn(COD_COLLECTION_SORT_ORDER, {
    message: `sortOrder must be one of ${COD_COLLECTION_SORT_ORDER.join(', ')}`,
  })
  sortOrder?: CodCollectionSortOrder;

  @IsOptional()
  @Transform(({ value }) => (value === '' ? undefined : value))
  @IsIn(COD_COLLECTION_PERIODS, {
    message: `period must be one of ${COD_COLLECTION_PERIODS.join(', ')}`,
  })
  period?: CodCollectionPeriod;
}
