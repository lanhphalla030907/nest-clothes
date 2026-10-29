import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  ORDER_STATUS,
  type OrderStatus,
} from '../constants/order-status.constants.js';

/**
 * The filters an administrator may apply to the order listing.
 *
 * Every value arrives as a query string, so each one is coerced and validated
 * before it reaches Prisma. `whitelist` plus `forbidNonWhitelisted` on the global
 * `ValidationPipe` is what makes an unknown parameter a 400 rather than a filter
 * that is silently ignored.
 *
 * `page` and `limit` have initialisers because a listing with no pagination
 * parameters is the common case. The initialiser applies when the property is
 * absent; a supplied value still has to be an integer in range, so `page=` and
 * `limit=abc` are refused rather than falling back to the default.
 *
 * `createdFrom` and `createdTo` are validated as ISO-8601 timestamps here. Their
 * *relative* order — `createdFrom` must not be later than `createdTo` — is a
 * cross-field rule and therefore belongs in `OrderService`, which already owns
 * order query semantics.
 */
export class AdminOrderListQueryDto {
  /** One-based page number. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  /** Page size, capped so one request cannot ask for the whole order table. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  @IsOptional()
  @IsString()
  @IsIn(Object.values(ORDER_STATUS))
  status?: OrderStatus;

  /**
   * Matched against the order-number prefix and the customer's names and email.
   *
   * Trimmed before validation so surrounding whitespace is not treated as part of
   * the search term. The length bound keeps a pathological pattern out of the
   * database; the repository escapes LIKE wildcards before building the query.
   */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  /** Inclusive lower bound on `orders.created_at`. */
  @IsOptional()
  @IsString()
  @IsISO8601({ strict: true, strictSeparator: true })
  createdFrom?: string;

  /** Inclusive upper bound on `orders.created_at`. */
  @IsOptional()
  @IsString()
  @IsISO8601({ strict: true, strictSeparator: true })
  createdTo?: string;
}
