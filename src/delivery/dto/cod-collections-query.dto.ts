import { Transform } from 'class-transformer';
import {
  IsDateString,
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
 * Query contract for `GET /delivery/staff/cod-collections`.
 *
 * `page`/`limit` follow the existing `DeliveryQueryDto` pagination shape.
 * `startDate`/`endDate` are inclusive calendar-day bounds on `collectedAt`.
 * A supplied `startDate` after `endDate` is rejected in the service layer,
 * because class-validator cannot express a cross-field comparison.
 */
export class CodCollectionsQueryDto {
  @IsOptional()
  @Transform(({ value }) => (value === '' ? undefined : value))
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Transform(({ value }) => (value === '' ? undefined : value))
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

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
  @Transform(toOptionalTrimmed)
  @IsUUID()
  orderId?: string;
}
