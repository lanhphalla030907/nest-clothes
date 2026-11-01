import { toMoneyString } from '../../common/utils/money.js';

/** Kinds of COD reconciliation discrepancies detectable from existing data. */
export const COD_RECONCILIATION_DISCREPANCY_TYPES = [
  'missing-collection',
  'amount-mismatch',
  'currency-mismatch',
] as const;
export type CodReconciliationDiscrepancyType =
  (typeof COD_RECONCILIATION_DISCREPANCY_TYPES)[number];

/** One reconciliation discrepancy row. */
export class ReconciliationDiscrepancyRowDto {
  orderId: string;
  orderNumber: string | null;
  orderStatus: string | null;
  discrepancyType: CodReconciliationDiscrepancyType;
  expectedAmount: string;
  actualAmount: string | null;
  currency: string;
  collectionId: string | null;

  static fromEntity(entity: {
    orderId: string;
    orderNumber: string | null;
    orderStatus: string | null;
    discrepancyType: CodReconciliationDiscrepancyType;
    totalAmount: unknown;
    collectedAmount: unknown | null;
    currency: string;
    collectionId: string | null;
  }): ReconciliationDiscrepancyRowDto {
    const dto = new ReconciliationDiscrepancyRowDto();
    dto.orderId = entity.orderId;
    dto.orderNumber = entity.orderNumber;
    dto.orderStatus = entity.orderStatus;
    dto.discrepancyType = entity.discrepancyType;
    dto.expectedAmount = toMoneyString(entity.totalAmount);
    dto.actualAmount =
      entity.collectedAmount === null
        ? null
        : toMoneyString(entity.collectedAmount);
    dto.currency = entity.currency;
    dto.collectionId = entity.collectionId;
    return dto;
  }
}

/**
 * The administrative COD reconciliation discrepancy listing response.
 *
 * `items` is the page and `pagination.total` describes the same filtered result
 * set the page was drawn from.
 */
export class AdminCodReconciliationDiscrepancyListDto {
  items: ReconciliationDiscrepancyRowDto[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };

  static fromResult(input: {
    items: ReconciliationDiscrepancyRowDto[];
    total: number;
    page: number;
    limit: number;
  }): AdminCodReconciliationDiscrepancyListDto {
    const dto = new AdminCodReconciliationDiscrepancyListDto();
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
