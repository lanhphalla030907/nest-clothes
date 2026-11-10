import { FinanceDateRangeQueryDto } from './finance-date-range-query.dto.js';

/**
 * Query contract for `GET /admin/finance/cash-reconciliation`.
 *
 * Cash is measured by when it moved, not by delivery date, so this endpoint
 * deliberately has no `basis` parameter. Its range applies to `paid_at` and
 * `collected_at`; receivables are dated by delivery, and unpaid online orders by
 * creation, because those have no cash event to date them by.
 */
export class CashReconciliationQueryDto extends FinanceDateRangeQueryDto {}
