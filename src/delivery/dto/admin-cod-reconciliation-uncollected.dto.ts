import { toMoneyString } from '../../common/utils/money.js';

/** One delivered COD order that has no recorded collection. */
export class UncollectedDeliveredCodOrderDto {
  orderId: string;
  orderNumber: string;
  orderStatus: string;
  expectedAmount: string;
  currency: string;
  deliveryStaffId: string | null;
  deliveryStaff: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  } | null;
  deliveredAt: Date | null;

  static fromEntity(entity: {
    orderId: string;
    orderNumber: string;
    orderStatus: string;
    totalAmount?: unknown;
    expectedAmount?: unknown;
    currency: string;
    deliveryStaffId: string | null;
    deliveryStaff: {
      id: string;
      firstName: string;
      lastName: string;
      email: string;
    } | null;
    deliveredAt: Date | null;
  }): UncollectedDeliveredCodOrderDto {
    const dto = new UncollectedDeliveredCodOrderDto();
    dto.orderId = entity.orderId;
    dto.orderNumber = entity.orderNumber;
    dto.orderStatus = entity.orderStatus;
    dto.expectedAmount = toMoneyString(
      entity.expectedAmount ?? entity.totalAmount,
    );
    dto.currency = entity.currency;
    dto.deliveryStaffId = entity.deliveryStaffId;
    dto.deliveryStaff = entity.deliveryStaff;
    dto.deliveredAt = entity.deliveredAt;
    return dto;
  }
}

/**
 * The administrative listing of delivered COD orders without a collection.
 *
 * `items` is the page and `pagination` describes the filtered result set the
 * page was drawn from, matching the other reconciliation listing responses.
 */
export class AdminCodReconciliationUncollectedListDto {
  items: UncollectedDeliveredCodOrderDto[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };

  static fromResult(input: {
    items: UncollectedDeliveredCodOrderDto[];
    total: number;
    page: number;
    limit: number;
  }): AdminCodReconciliationUncollectedListDto {
    const dto = new AdminCodReconciliationUncollectedListDto();
    dto.items = input.items;
    dto.pagination = {
      page: input.page,
      limit: input.limit,
      total: input.total,
      totalPages: Math.ceil(input.total / input.limit),
    };
    return dto;
  }
}
