/**
 * Finance reporting constants.
 *
 * These values are business policy, not schema details, so they live here rather
 * than being repeated in the repository or the service. The reporting timezone is
 * deliberately a single constant: a dashboard whose day boundary moves with the
 * server's clock is not comparable between deployments.
 */

/** The timezone every reporting day/week/month boundary is calculated in. */
export const FINANCE_REPORTING_TIMEZONE = 'Asia/Phnom_Penh';

/**
 * `Asia/Phnom_Penh` has been a fixed UTC+7 offset with no daylight-saving
 * transitions, so a constant offset is exact for every date this application can
 * hold. Keeping it explicit means the conversion is visible and testable instead
 * of hidden in the host's local timezone.
 */
export const FINANCE_REPORTING_UTC_OFFSET_MINUTES = 7 * 60;

/** The default reporting window, in days, when the caller supplies no dates. */
export const FINANCE_DEFAULT_RANGE_DAYS = 30;

/** The largest reporting window an administrator may request. */
export const FINANCE_MAX_RANGE_DAYS = 366;

/** The only revenue-recognition bases the finance endpoints expose. */
export const FINANCE_BASES = ['delivered', 'booked'] as const;
export type FinanceBasis = (typeof FINANCE_BASES)[number];

/** The default basis. Delivered is the accrual view and the safest default. */
export const FINANCE_DEFAULT_BASIS: FinanceBasis = 'delivered';

/** Bucket sizes supported by the revenue-trend endpoint. */
export const FINANCE_TREND_GRANULARITIES = ['day', 'week', 'month'] as const;
export type FinanceTrendGranularity =
  (typeof FINANCE_TREND_GRANULARITIES)[number];

/** The default trend bucket. */
export const FINANCE_DEFAULT_GRANULARITY: FinanceTrendGranularity = 'day';

/** Columns the product-profitability listing may be sorted by. */
export const FINANCE_PRODUCT_SORT_BY = [
  'revenue',
  'profit',
  'units',
  'margin',
  'productName',
] as const;
export type FinanceProductSortBy = (typeof FINANCE_PRODUCT_SORT_BY)[number];

/** Sort directions. */
export const FINANCE_SORT_ORDERS = ['asc', 'desc'] as const;
export type FinanceSortOrder = (typeof FINANCE_SORT_ORDERS)[number];

/** Metrics a product ranking may be ordered by. */
export const FINANCE_RANKING_METRICS = ['revenue', 'profit', 'units'] as const;
export type FinanceRankingMetric = (typeof FINANCE_RANKING_METRICS)[number];

/** Default and maximum ranking size. */
export const FINANCE_DEFAULT_RANKING_LIMIT = 10;
export const FINANCE_MAX_RANKING_LIMIT = 50;

/** Default and maximum product-listing page size. */
export const FINANCE_DEFAULT_PAGE_SIZE = 20;
export const FINANCE_MAX_PAGE_SIZE = 100;

/**
 * Promotion discount types that reduce merchandise revenue.
 *
 * `FREE_SHIPPING` is the one type that reduces shipping revenue instead, which is
 * why it is named separately rather than being treated as "not a product
 * discount" implicitly.
 */
export const FREE_SHIPPING_DISCOUNT_TYPE = 'FREE_SHIPPING';

/** Order statuses that are terminal and therefore never deferred cash. */
export const FINANCE_TERMINAL_ORDER_STATUSES = [
  'DELIVERED',
  'CANCELLED',
] as const;

/** ISO 4217 alphabetic code, matching the shape check on `orders.currency`. */
export const FINANCE_CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** A calendar date in the reporting timezone, without a time component. */
export const FINANCE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
