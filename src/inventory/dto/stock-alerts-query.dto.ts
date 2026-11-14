import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import type { StockAlertFilter } from './stock-alerts-response.dto.js';

/** The only page sizes the stock table accepts. */
export const STOCK_ALERT_PAGE_SIZES = [10, 25, 50] as const;
export type StockAlertPageSize = (typeof STOCK_ALERT_PAGE_SIZES)[number];

export const DEFAULT_STOCK_ALERT_PAGE = 1;
export const DEFAULT_STOCK_ALERT_LIMIT = 10;

/**
 * The query for the paginated stock alerts table.
 *
 * `page` and `limit` are coerced from query strings and validated before they
 * reach Prisma, so a non-integer or out-of-range page size is a 400 rather than
 * a silent fallback. `limit` is restricted to the supported sizes; the default
 * applies when the parameter is absent.
 *
 * `search` matches the product name or the variant SKU, case-insensitively, and
 * is trimmed before validation.
 *
 * The status filter defaults to `alerts` (low stock and out of stock) and is
 * applied by the service, not here.
 */
export class StockAlertsQueryDto {
  /** One-based page number. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = DEFAULT_STOCK_ALERT_PAGE;

  /** Page size, restricted to the supported sizes. */
  @Type(() => Number)
  @IsInt()
  @IsIn(STOCK_ALERT_PAGE_SIZES as unknown as number[])
  limit: number = DEFAULT_STOCK_ALERT_LIMIT;

  @IsOptional()
  @IsString()
  @IsIn(['alerts', 'all', 'in', 'low', 'out'])
  status?: StockAlertFilter;

  /**
   * Matched against the product name and the variant SKU, case-insensitively.
   *
   * Trimmed before validation so surrounding whitespace is not treated as part of
   * the search term. The length bound keeps a pathological pattern out of the
   * database.
   */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}
