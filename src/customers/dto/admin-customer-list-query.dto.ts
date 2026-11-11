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
  CUSTOMERS_DEFAULT_PAGE_SIZE,
  CUSTOMERS_MAX_PAGE_SIZE,
  CUSTOMER_LIST_SORT_BY,
  CUSTOMER_LIST_SORT_ORDERS,
  CUSTOMER_ORDER_ACTIVITY,
  type CustomerListSortBy,
  type CustomerListSortOrder,
  type CustomerOrderActivity,
} from '../customers.constants.js';

/**
 * The filters an administrator may apply to the customer listing.
 *
 * Every value arrives as a query string, so each one is coerced and validated
 * before it reaches a query. `whitelist` plus `forbidNonWhitelisted` on the
 * global `ValidationPipe` is what makes an unknown parameter a 400 rather than
 * a filter that is silently ignored.
 *
 * `page` and `limit` have initialisers because a listing with no pagination
 * parameters is the common case. The initialiser applies when the property is
 * absent; a supplied value still has to be an integer in range, so `page=` and
 * `limit=abc` are refused rather than falling back to the default.
 *
 * `status` is a free-form string rather than an enum: `users.status` is a
 * VARCHAR column with no closed value set in the schema, and only `ACTIVE` is
 * ever written today. A maximal length keeps a pathological value out of the
 * database; anything else is an equality match that finds no rows, which is
 * the honest answer for a status nobody wrote.
 *
 * `registeredFrom` and `registeredTo` are validated as ISO-8601 timestamps
 * here. Their *relative* order — `registeredFrom` must not be later than
 * `registeredTo` — is a cross-field rule and therefore belongs in
 * `CustomersService`, which owns customer query semantics.
 */
export class AdminCustomerListQueryDto {
  /** One-based page number. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  /** Page size, capped so one request cannot ask for the whole user table. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(CUSTOMERS_MAX_PAGE_SIZE)
  limit: number = CUSTOMERS_DEFAULT_PAGE_SIZE;

  /**
   * Matched, case-insensitively, inside the customer's names, email and phone.
   *
   * Trimmed before validation so surrounding whitespace is not treated as part
   * of the search term. The length bound keeps a pathological pattern out of
   * the database; the repository escapes LIKE wildcards before building the
   * query.
   */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  /** Exact match on `users.status`. */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  status?: string;

  /** Inclusive lower bound on `users.created_at`. */
  @IsOptional()
  @IsString()
  @IsISO8601({ strict: true, strictSeparator: true })
  registeredFrom?: string;

  /** Inclusive upper bound on `users.created_at`. */
  @IsOptional()
  @IsString()
  @IsISO8601({ strict: true, strictSeparator: true })
  registeredTo?: string;

  /** Restrict to customers with or without at least one order, any status. */
  @IsOptional()
  @IsIn(CUSTOMER_ORDER_ACTIVITY)
  orderActivity?: CustomerOrderActivity;

  @IsOptional()
  @IsIn(CUSTOMER_LIST_SORT_BY)
  sortBy?: CustomerListSortBy;

  @IsOptional()
  @IsIn(CUSTOMER_LIST_SORT_ORDERS)
  sortOrder?: CustomerListSortOrder;
}
