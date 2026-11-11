import { NEW_CUSTOMER_WINDOW_DAYS } from '../customers.constants.js';
import type { CustomerStatsCounts } from '../customers.repository.js';

/**
 * The four headline counters of the customer overview.
 *
 * Every count is over `role = 'CUSTOMER'` accounts only — administrators and
 * delivery staff share the `users` table and are not customer records.
 *
 * - `totalCustomers`: every customer account.
 * - `activeCustomers`: customer accounts whose `status` is `ACTIVE`, the only
 *   value this application writes.
 * - `newCustomers`: customer accounts created within
 *   `newCustomerWindowDays` of "now".
 * - `customersWithOrders`: customer accounts with at least one order in **any**
 *   status, including `CANCELLED` — the question is whether a relationship
 *   exists, not whether money moved.
 *
 * `newCustomerWindowDays` is echoed so a client never has to guess which
 * registrations `newCustomers` covered.
 */
export class AdminCustomerStatsResponseDto {
  totalCustomers: number;
  activeCustomers: number;
  newCustomers: number;
  customersWithOrders: number;
  newCustomerWindowDays: number;

  static fromCounts(
    counts: CustomerStatsCounts,
  ): AdminCustomerStatsResponseDto {
    const dto = new AdminCustomerStatsResponseDto();

    dto.totalCustomers = counts.totalCustomers;
    dto.activeCustomers = counts.activeCustomers;
    dto.newCustomers = counts.newCustomers;
    dto.customersWithOrders = counts.customersWithOrders;
    dto.newCustomerWindowDays = NEW_CUSTOMER_WINDOW_DAYS;
    return dto;
  }
}
