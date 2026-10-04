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
