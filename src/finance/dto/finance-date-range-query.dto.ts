import { Transform } from 'class-transformer';
import { IsOptional, IsString, Matches } from 'class-validator';
import {
  FINANCE_CURRENCY_PATTERN,
  FINANCE_DATE_PATTERN,
} from '../finance.constants.js';
import {
  toCurrencyCode,
  toOptionalTrimmed,
} from './finance-query.transforms.js';

/**
 * The date range and currency filter shared by every finance endpoint.
 *
 * Dates are calendar labels in the reporting timezone (`Asia/Phnom_Penh`), not
 * instants. The service converts the inclusive `from`/`to` labels into a
 * half-open UTC window so a day boundary cannot be counted twice.
 */
export class FinanceDateRangeQueryDto {
  /** First reporting date, inclusive, as `YYYY-MM-DD`. */
  @IsOptional()
  @Transform(toOptionalTrimmed)
  @IsString()
  @Matches(FINANCE_DATE_PATTERN, {
    message: 'from must be a YYYY-MM-DD date',
  })
  from?: string;

  /** Last reporting date, inclusive, as `YYYY-MM-DD`. */
  @IsOptional()
  @Transform(toOptionalTrimmed)
  @IsString()
  @Matches(FINANCE_DATE_PATTERN, {
    message: 'to must be a YYYY-MM-DD date',
  })
  to?: string;

  /** Restrict the report to one ISO 4217 currency. Omit for all currencies. */
  @IsOptional()
  @Transform(toCurrencyCode)
  @IsString()
  @Matches(FINANCE_CURRENCY_PATTERN, {
    message: 'currency must be a three-letter ISO 4217 code',
  })
  currency?: string;
}
