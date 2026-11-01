import { toMoneyString } from '../../common/utils/money.js';

/** One row of the administrative COD reconciliation listing. */
export class ReconciliationListRowDto {
  orderId: string;
  orderNumber: string | null;
  orderStatus: string | null;
  paymentMethod: string | null;
  expectedAmount: string;
  currency: string;
  collectedAmount: string | null;
  collectionId: string | null;
  collectedAt: Date | null;
  collectedById: string | null;
  collectedBy: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  } | null;
  discrepancy: boolean;

  static fromEntity(entity: {
    orderId: string;
    orderNumber: string | null;
    orderStatus: string | null;
    paymentMethod: string | null;
    totalAmount: unknown;
    currency: string;
    collectedAmount: unknown | null;
    collectionId: string | null;
    collectedAt: Date | null;
    collectedById: string | null;
    collectedBy: {
      id: string;
      firstName: string;
      lastName: string;
      email: string;
    } | null;
    discrepancy: boolean;
  }): ReconciliationListRowDto {
    const dto = new ReconciliationListRowDto();
    dto.orderId = entity.orderId;
    dto.orderNumber = entity.orderNumber;
    dto.orderStatus = entity.orderStatus;
    dto.paymentMethod = entity.paymentMethod;
    dto.expectedAmount = toMoneyString(entity.totalAmount);
    dto.currency = entity.currency;
    dto.collectedAmount =
      entity.collectedAmount === null
        ? null
        : toMoneyString(entity.collectedAmount);
    dto.collectionId = entity.collectionId;
    dto.collectedAt = entity.collectedAt;
    dto.collectedById = entity.collectedById;
    dto.collectedBy = entity.collectedBy;
    dto.discrepancy = entity.discrepancy;
    return dto;
  }
}

/**
 * The administrative COD reconciliation listing response.
 *
 * `items` is the page and `pagination.total` describes the same filtered result
 * set the page was drawn from.
 */
export class AdminCodReconciliationListDto {
  items: ReconciliationListRowDto[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };

  static fromResult(input: {
    items: ReconciliationListRowDto[];
    total: number;
    page: number;
    limit: number;
  }): AdminCodReconciliationListDto {
    const dto = new AdminCodReconciliationListDto();
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
