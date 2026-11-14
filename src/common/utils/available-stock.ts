/**
 * The counters a sellable amount is derived from.
 *
 * Structurally compatible with the `Inventory` model and with the subset the
 * inventory response DTO exposes, so no caller has to widen or narrow to use it.
 */
export interface StockCounters {
  quantity: number;
  reservedQuantity: number;
}

/**
 * The sellable amount for a stock row: `quantity - reservedQuantity`.
 *
 * The value is derived, never stored: persisting it would create a third number
 * that could disagree with the two it comes from. Both counters are guaranteed
 * non-negative and `reservedQuantity <= quantity` by the `CHECK` constraints on
 * `inventory`, so the result is a whole number and never negative.
 *
 * It lives in `common/utils` because more than one layer needs the same fact and
 * they must not each recompute it: the inventory response DTO reports it, the
 * cart service validates a requested quantity against it, and the checkout phase
 * will need the identical comparison when it starts reserving. A second
 * hand-rolled `quantity - reservedQuantity` would be a place for the two to
 * disagree.
 */
export function availableStock(counters: StockCounters): number {
  return counters.quantity - counters.reservedQuantity;
}

/** The three stock states an administrator acts on. */
export type StockStatus = 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK';

/**
 * Available stock at or below this amount is low stock.
 *
 * The threshold is a display rule, not a stored fact: the counters stay the only
 * source of truth and the status is derived on the way out.
 */
export const LOW_STOCK_THRESHOLD = 10;

/**
 * The stock state for a derived available amount.
 *
 * The order of the comparisons is the whole rule: `0` and below are out of
 * stock, `1..LOW_STOCK_THRESHOLD` are low, and anything above is in stock.
 * `availableStock` already guarantees a whole number, so there is no gap between
 * the boundaries.
 */
export function stockStatusFor(available: number): StockStatus {
  if (available <= 0) return 'OUT_OF_STOCK';
  if (available <= LOW_STOCK_THRESHOLD) return 'LOW_STOCK';
  return 'IN_STOCK';
}
