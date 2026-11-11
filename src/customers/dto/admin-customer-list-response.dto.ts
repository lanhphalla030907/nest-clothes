import { toMoneyString } from '../../common/utils/money.js';
import type { AdminCustomerRow } from '../customers.repository.js';
import type { AdminCustomerMoneyDto } from './admin-customer-money.dto.js';

/** Pagination metadata for the administrative customer listing. */
export class AdminCustomerPaginationDto {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/**
 * One row of the administrative customer listing.
 *
 * The row is a summary: identity, contact, status, registration date and the
 * order aggregates an operator needs to recognise and rank a customer. The
 * full profile — address book, recent orders, per-order statistics — is the
 * detail response, fetched on demand.
 *
 * `totalOrders` counts every order in any status, including `CANCELLED`; the
 * spending rule behind `totalSpentByCurrency` is documented on
 * `CustomersRepository`.
 */
export class AdminCustomerSummaryResponseDto {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  status: string;
  createdAt: Date;
  /** Every order, in any status, including `CANCELLED`. */
  totalOrders: number;
  /**
   * Spendable spend per currency, one entry per currency. Never combined
   * across currencies; empty when the customer has no spendable orders.
   */
  totalSpentByCurrency: AdminCustomerMoneyDto[];
  /** When the customer's most recent order was placed, any status. */
  lastOrderAt: Date | null;

  static fromRow(row: AdminCustomerRow): AdminCustomerSummaryResponseDto {
    const dto = new AdminCustomerSummaryResponseDto();

    dto.id = row.id;
    dto.firstName = row.first_name;
    dto.lastName = row.last_name;
    dto.email = row.email;
    dto.phone = row.phone;
    dto.status = row.status;
    dto.createdAt = row.created_at;
    dto.totalOrders = row.total_orders;
    dto.totalSpentByCurrency = row.total_spent_by_currency.map((entry) => ({
      currency: entry.currency,
      amount: toMoneyString(entry.amount),
    }));
    dto.lastOrderAt = row.last_order_at;
    return dto;
  }
}

/**
 * The administrative customer listing.
 *
 * `items` is the page, `pagination.total` is the number of customers matching
 * the same filters, and `totalPages` is zero for an empty result. The page and
 * the total are produced from one shared `WHERE` fragment in one transaction,
 * so they cannot describe different filters.
 */
export class AdminCustomerListResponseDto {
  items: AdminCustomerSummaryResponseDto[];
  pagination: AdminCustomerPaginationDto;

  static fromResult(
    result: { items: AdminCustomerRow[]; total: number },
    page: number,
    limit: number,
  ): AdminCustomerListResponseDto {
    const dto = new AdminCustomerListResponseDto();

    dto.items = result.items.map((row) =>
      AdminCustomerSummaryResponseDto.fromRow(row),
    );
    dto.pagination = {
      page,
      limit,
      total: result.total,
      totalPages: limit > 0 ? Math.ceil(result.total / limit) : 0,
    };
    return dto;
  }
}
