/**
 * The two ways a promotion can be selected.
 *
 * `COUPON` is chosen by a code the customer enters. `AUTOMATIC` is chosen by the
 * cart itself and has no code. The values are stored in `promotions.kind` as
 * `VARCHAR`, following the project's existing status-column convention rather
 * than a PostgreSQL enum, so adding a selection strategy later is a code change
 * instead of an `ALTER TYPE`.
 */
export const PROMOTION_KIND = {
  COUPON: 'COUPON',
  AUTOMATIC: 'AUTOMATIC',
} as const;

export type PromotionKind =
  (typeof PROMOTION_KIND)[keyof typeof PROMOTION_KIND];

export const PROMOTION_KINDS: readonly PromotionKind[] =
  Object.values(PROMOTION_KIND);

/**
 * What a promotion actually subtracts.
 *
 * `PERCENTAGE` and `FIXED_AMOUNT` apply to the product subtotal only.
 * `FREE_SHIPPING` is a separate type whose discount equals the original shipping
 * fee, keeping the fee itself intact on the order for reporting.
 */
export const DISCOUNT_TYPE = {
  PERCENTAGE: 'PERCENTAGE',
  FIXED_AMOUNT: 'FIXED_AMOUNT',
  FREE_SHIPPING: 'FREE_SHIPPING',
} as const;

export type DiscountType = (typeof DISCOUNT_TYPE)[keyof typeof DISCOUNT_TYPE];

export const DISCOUNT_TYPES: readonly DiscountType[] =
  Object.values(DISCOUNT_TYPE);

/**
 * The largest percentage a `PERCENTAGE` promotion may carry.
 *
 * The migration enforces the same bound; this constant is what the service and
 * evaluator use so the error is raised before a database round trip.
 */
export const MAX_PERCENTAGE = 100;

/**
 * Default page size for the administrative listings.
 *
 * Matches the order listing so the future admin UI can use one pagination
 * contract across resources.
 */
export const DEFAULT_PROMOTION_PAGE_SIZE = 20;

/** Upper bound for one page, so no request can ask for the whole table. */
export const MAX_PROMOTION_PAGE_SIZE = 100;
