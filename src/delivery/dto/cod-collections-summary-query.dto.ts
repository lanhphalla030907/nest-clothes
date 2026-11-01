import { Transform } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';

/** ISO 4217 alphabetic code, matching the shape check on `orders.currency`. */
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

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

/**
 * Query contract for `GET /delivery/staff/cod-collections/summary`.
 *
 * Amounts are never aggregated across currencies: when `currency` is omitted the
 * response breaks totals down per currency in `totalsByCurrency`, and each
 * `periodBreakdown` row carries its own currency so mixed-currency periods stay
 * separated.
 */
export class CodCollectionsSummaryQueryDto {
  @IsOptional()
  @Transform(toOptionalTrimmed)
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @Transform(toOptionalTrimmed)
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @Transform(toCurrencyCode)
  @IsString()
  @Matches(CURRENCY_PATTERN, {
    message: 'currency must be a three-letter ISO 4217 code',
  })
  currency?: string;

  @IsOptional()
  @Transform(({ value }) => (value === '' ? undefined : value))
  @IsIn(COD_COLLECTION_PERIODS, {
    message: `period must be one of ${COD_COLLECTION_PERIODS.join(', ')}`,
  })
  period?: CodCollectionPeriod;
}
