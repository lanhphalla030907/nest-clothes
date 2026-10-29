import type { AdminOrderListRow } from '../repositories/order.repository.js';
import { AdminOrderSummaryResponseDto } from './admin-order-summary-response.dto.js';

/** Pagination metadata for the administrative order listing. */
export class AdminOrderPaginationDto {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/**
 * The administrative order listing.
 *
 * `items` is the page, `pagination.total` is the number of orders matching the
 * same filters, and `totalPages` is zero for an empty result. The page and total
 * are produced from one shared `where` clause, so they cannot describe different
 * filters.
 */
export class AdminOrderListResponseDto {
  items: AdminOrderSummaryResponseDto[];
  pagination: AdminOrderPaginationDto;

  static fromResult(
    result: { items: AdminOrderListRow[]; total: number },
    page: number,
    limit: number,
  ): AdminOrderListResponseDto {
    const dto = new AdminOrderListResponseDto();

    dto.items = result.items.map((order) =>
      AdminOrderSummaryResponseDto.fromEntity(order),
    );
    dto.pagination = {
      page,
      limit,
      total: result.total,
      totalPages: Math.ceil(result.total / limit),
    };
    return dto;
  }
}
