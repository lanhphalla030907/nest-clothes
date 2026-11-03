import type {
  CodReconciliationRun,
  CodReconciliationRunItem,
} from '../../generated/prisma/client.js';
import { toMoneyString } from '../../common/utils/money.js';
import type { CodReconciliationDiscrepancyType } from './admin-cod-reconciliation-discrepancy.dto.js';

function explainDiscrepancy(
  item: Pick<
    CodReconciliationRunItem,
    | 'discrepancyType'
    | 'expectedAmount'
    | 'currency'
    | 'collectedAmount'
    | 'collectionCurrency'
  >,
): string | null {
  const expected = `${toMoneyString(item.expectedAmount)} ${item.currency}`;

  switch (item.discrepancyType) {
    case 'missing-collection':
      return `No COD collection was recorded for the expected ${expected}.`;
    case 'amount-mismatch': {
      const collected =
        item.collectedAmount === null
          ? 'an unknown amount'
          : `${toMoneyString(item.collectedAmount)} ${item.collectionCurrency ?? item.currency}`;
      return `Collected ${collected}, which does not match the expected ${expected}.`;
    }
    case 'currency-mismatch': {
      const collected =
        item.collectedAmount === null
          ? 'an unknown amount'
          : `${toMoneyString(item.collectedAmount)} ${item.collectionCurrency ?? 'an unknown currency'}`;
      return `Collected ${collected} while the order expected ${expected}; the currencies are not comparable.`;
    }
    default:
      return null;
  }
}

/** One immutable order snapshot from a completed reconciliation run. */
export class ReconciliationRunSnapshotItemDto {
  id: string;
  orderId: string;
  orderNumber: string | null;
  orderStatus: string | null;
  paymentMethod: string | null;
  currency: string;
  expectedAmount: string;
  collectedAmount: string | null;
  collectionCurrency: string | null;
  collectionId: string | null;
  collectedAt: Date | null;
  collectedById: string | null;
  collectedBy: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  } | null;
  deliveryStaffId: string | null;
  deliveryStaff: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  } | null;
  deliveredAt: Date | null;
  assignmentId: string | null;
  discrepancy: boolean;
  discrepancyType: CodReconciliationDiscrepancyType | null;
  discrepancyExplanation: string | null;

  static fromEntity(entity: CodReconciliationRunItem): ReconciliationRunSnapshotItemDto {
    const dto = new ReconciliationRunSnapshotItemDto();
    dto.id = entity.id;
    dto.orderId = entity.orderId;
    dto.orderNumber = entity.orderNumber;
    dto.orderStatus = entity.orderStatus;
    dto.paymentMethod = entity.paymentMethod;
    dto.currency = entity.currency;
    dto.expectedAmount = toMoneyString(entity.expectedAmount);
    dto.collectedAmount =
      entity.collectedAmount === null
        ? null
        : toMoneyString(entity.collectedAmount);
    dto.collectionCurrency = entity.collectionCurrency;
    dto.collectionId = entity.collectionId;
    dto.collectedAt = entity.collectedAt;
    dto.collectedById = entity.collectedById;
    dto.collectedBy = entity.collectedById
      ? {
          id: entity.collectedById,
          firstName: entity.collectedByFirstName ?? '',
          lastName: entity.collectedByLastName ?? '',
          email: entity.collectedByEmail ?? '',
        }
      : null;
    dto.deliveryStaffId = entity.deliveryStaffId;
    dto.deliveryStaff = entity.deliveryStaffId
      ? {
          id: entity.deliveryStaffId,
          firstName: entity.deliveryStaffFirstName ?? '',
          lastName: entity.deliveryStaffLastName ?? '',
          email: entity.deliveryStaffEmail ?? '',
        }
      : null;
    dto.deliveredAt = entity.deliveredAt;
    dto.assignmentId = entity.assignmentId;
    dto.discrepancy = entity.discrepancy;
    dto.discrepancyType =
      entity.discrepancyType as CodReconciliationDiscrepancyType | null;
    dto.discrepancyExplanation = explainDiscrepancy(entity);
    return dto;
  }
}

/**
 * Expected and collected totals for one currency.
 *
 * The two sides are deliberately separate columns with no derived difference:
 * a USD order collected in KHR contributes to USD expected and KHR collected,
 * never to a single mixed-currency total.
 */
export class ReconciliationRunCurrencySummaryDto {
  currency: string;
  expectedCount: number;
  expectedAmount: string;
  matchedCount: number;
  discrepancyCount: number;
  collectedCount: number;
  collectedAmount: string;

  static fromEntity(entity: {
    currency: string;
    expectedCount: number;
    expectedAmount: unknown;
    matchedCount: number;
    discrepancyCount: number;
    collectedCount: number;
    collectedAmount: unknown;
  }): ReconciliationRunCurrencySummaryDto {
    const dto = new ReconciliationRunCurrencySummaryDto();
    dto.currency = entity.currency;
    dto.expectedCount = entity.expectedCount;
    dto.expectedAmount = toMoneyString(entity.expectedAmount);
    dto.matchedCount = entity.matchedCount;
    dto.discrepancyCount = entity.discrepancyCount;
    dto.collectedCount = entity.collectedCount;
    dto.collectedAmount = toMoneyString(entity.collectedAmount);
    return dto;
  }
}

/**
 * A reconciliation run's durable metadata plus its paginated snapshot.
 *
 * `hasSnapshot` mirrors `snapshotsWritten`; it is never inferred from item
 * count. Legacy runs return empty `items` and `summaryByCurrency` because no
 * snapshot was ever persisted for them, and live business tables are never
 * consulted to reconstruct one.
 */
export class AdminCodReconciliationRunDetailDto {
  id: string;
  triggerType: string;
  status: string;
  windowStart: Date;
  windowEnd: Date;
  processedCount: number;
  matchedCount: number;
  discrepancyCount: number;
  uncollectedCount: number;
  errorMessage: string | null;
  startedAt: Date;
  completedAt: Date | null;
  createdAt: Date;
  hasSnapshot: boolean;
  items: ReconciliationRunSnapshotItemDto[];
  summaryByCurrency: ReconciliationRunCurrencySummaryDto[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };

  static fromResult(input: {
    run: CodReconciliationRun;
    items: CodReconciliationRunItem[];
    summaryByCurrency: Array<{
      currency: string;
      expectedCount: number;
      expectedAmount: unknown;
      matchedCount: number;
      discrepancyCount: number;
      collectedCount: number;
      collectedAmount: unknown;
    }>;
    page: number;
    limit: number;
    total: number;
  }): AdminCodReconciliationRunDetailDto {
    const dto = new AdminCodReconciliationRunDetailDto();
    dto.id = input.run.id;
    dto.triggerType = input.run.triggerType;
    dto.status = input.run.status;
    dto.windowStart = input.run.windowStart;
    dto.windowEnd = input.run.windowEnd;
    dto.processedCount = input.run.processedCount;
    dto.matchedCount = input.run.matchedCount;
    dto.discrepancyCount = input.run.discrepancyCount;
    dto.uncollectedCount = input.run.uncollectedCount;
    dto.errorMessage = input.run.errorMessage;
    dto.startedAt = input.run.startedAt;
    dto.completedAt = input.run.completedAt;
    dto.createdAt = input.run.createdAt;
    dto.hasSnapshot = input.run.snapshotsWritten;
    dto.items = input.items.map((item) =>
      ReconciliationRunSnapshotItemDto.fromEntity(item),
    );
    dto.summaryByCurrency = input.summaryByCurrency.map((entry) =>
      ReconciliationRunCurrencySummaryDto.fromEntity(entry),
    );
    dto.pagination = {
      page: input.page,
      limit: input.limit,
      total: input.total,
      totalPages: Math.ceil(input.total / input.limit),
    };
    return dto;
  }
}
