import type { StockStatus } from '../../common/utils/available-stock.js';

/**
 * The three filters the stock table offers.
 *
 * `alerts` is the default and means "low stock and out of stock" — the rows an
 * administrator has to act on. The other three are the explicit views.
 */
export type StockAlertFilter = 'alerts' | 'all' | 'in' | 'low' | 'out';

/**
 * One variant's stock row, projected for the admin table.
 *
 * `available` is derived (`quantity - reservedQuantity`) and `status` is derived
 * from it, so neither is a stored column that could disagree with the counters.
 * `color` and `size` are read from the variant's option pairs and are `null`
 * when the variant has no such option — never an invented default.
 */
export class StockAlertItemDto {
  variantId!: string;
  productId!: string;
  productName!: string;
  /** The primary image, or the first by sort order; `null` when none exists. */
  productImage!: string | null;
  sku!: string;
  color!: string | null;
  size!: string | null;
  quantity!: number;
  reservedQuantity!: number;
  available!: number;
  status!: StockStatus;
}

/**
 * Counts across every variant that has a stock row.
 *
 * These are always the full totals, independent of the table filter, so the
 * three cards do not change when the user switches between All / Low / Out.
 */
export class StockAlertSummaryDto {
  inStock!: number;
  lowStock!: number;
  outOfStock!: number;
  /** Variants with a stock row. Variants without one are not counted. */
  total!: number;
}

export class StockAlertsResponseDto {
  summary!: StockAlertSummaryDto;
  items!: StockAlertItemDto[];
  pagination!: StockAlertsPaginationDto;
}

/**
 * Pagination metadata for the stock alerts table.
 *
 * `total` and `totalPages` describe every record matching the search filter,
 * not only the current page, so the summary cards and the pager agree.
 */
export class StockAlertsPaginationDto {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}