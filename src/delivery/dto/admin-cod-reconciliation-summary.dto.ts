import { toMoneyString } from '../../common/utils/money.js';

/** One currency-scoped reconciliation total. */
export class ReconciliationCurrencyTotalDto {
  currency: string;
  collectedAmount: string;
  expectedAmount: string;
  outstandingAmount: string;
  count: number;

  static fromEntity(entity: {
    currency: string;
    collectedAmount: unknown;
    expectedAmount: unknown;
    outstandingAmount: unknown;
    count: number;
  }): ReconciliationCurrencyTotalDto {
    const dto = new ReconciliationCurrencyTotalDto();
    dto.currency = entity.currency;
    dto.collectedAmount = toMoneyString(entity.collectedAmount);
    dto.expectedAmount = toMoneyString(entity.expectedAmount);
    dto.outstandingAmount = toMoneyString(entity.outstandingAmount);
    dto.count = entity.count;
    return dto;
  }
}

/** One expected-amount row grouped by currency. */
export class ExpectedAmountByCurrencyDto {
  currency: string;
  totalAmount: string;

  static fromEntity(entity: {
    currency: string;
    totalAmount: unknown;
  }): ExpectedAmountByCurrencyDto {
    const dto = new ExpectedAmountByCurrencyDto();
    dto.currency = entity.currency;
    dto.totalAmount = toMoneyString(entity.totalAmount);
    return dto;
  }
}

/** One outstanding-amount row grouped by currency. */
export class OutstandingAmountByCurrencyDto {
  currency: string;
  totalAmount: string;

  static fromEntity(entity: {
    currency: string;
    totalAmount: unknown;
  }): OutstandingAmountByCurrencyDto {
    const dto = new OutstandingAmountByCurrencyDto();
    dto.currency = entity.currency;
    dto.totalAmount = toMoneyString(entity.totalAmount);
    return dto;
  }
}

/** One period-scoped reconciliation breakdown row. */
export class ReconciliationPeriodBreakdownDto {
  period: string;
  currency: string;
  collectedAmount: string;
  expectedAmount: string;
  outstandingAmount: string;
  count: number;

  static fromEntity(entity: {
    period: string;
    currency: string;
    collectedAmount: unknown;
    expectedAmount: unknown;
    outstandingAmount: unknown;
    count: number;
  }): ReconciliationPeriodBreakdownDto {
    const dto = new ReconciliationPeriodBreakdownDto();
    dto.period = entity.period;
    dto.currency = entity.currency;
    dto.collectedAmount = toMoneyString(entity.collectedAmount);
    dto.expectedAmount = toMoneyString(entity.expectedAmount);
    dto.outstandingAmount = toMoneyString(entity.outstandingAmount);
    dto.count = entity.count;
    return dto;
  }
}

/** One staff-member reconciliation breakdown row. */
export class ReconciliationStaffBreakdownDto {
  staffId: string;
  staff: { id: string; firstName: string; lastName: string; email: string };
  currency: string;
  collectedAmount: string;
  expectedAmount: string;
  outstandingAmount: string;
  count: number;

  static fromEntity(entity: {
    staffId: string;
    staff: {
      id: string;
      firstName: string;
      lastName: string;
      email: string;
    };
    currency: string;
    collectedAmount: unknown;
    expectedAmount: unknown;
    outstandingAmount: unknown;
    count: number;
  }): ReconciliationStaffBreakdownDto {
    const dto = new ReconciliationStaffBreakdownDto();
    dto.staffId = entity.staffId;
    dto.staff = entity.staff;
    dto.currency = entity.currency;
    dto.collectedAmount = toMoneyString(entity.collectedAmount);
    dto.expectedAmount = toMoneyString(entity.expectedAmount);
    dto.outstandingAmount = toMoneyString(entity.outstandingAmount);
    dto.count = entity.count;
    return dto;
  }
}

/**
 * The administrative COD reconciliation summary.
 *
 * Amounts are aggregated per currency and never mixed: collected, expected and
 * outstanding amounts each keep their own currency so mixed-currency totals
 * stay separated. All monetary values are fixed two-decimal strings produced
 * from `Prisma.Decimal` through `toMoneyString` — never JavaScript numbers.
 */
export class AdminCodReconciliationSummaryDto {
  totalCollections: number;
  totalsByCurrency: ReconciliationCurrencyTotalDto[];
  expectedAmountByCurrency: ExpectedAmountByCurrencyDto[];
  outstandingAmountByCurrency: OutstandingAmountByCurrencyDto[];
  collectionCount: number;
  discrepancyCount: number;
  firstCollectionAt: Date | null;
  lastCollectionAt: Date | null;
  periodBreakdown: ReconciliationPeriodBreakdownDto[];
  staffBreakdown: ReconciliationStaffBreakdownDto[];

  static fromEntity(input: {
    totalCollections: number;
    totalsByCurrency: Array<{
      currency: string;
      collectedAmount: unknown;
      expectedAmount: unknown;
      outstandingAmount: unknown;
      count: number;
    }>;
    expectedAmountByCurrency: Array<{
      currency: string;
      totalAmount: unknown;
    }>;
    outstandingAmountByCurrency: Array<{
      currency: string;
      totalAmount: unknown;
    }>;
    collectionCount: number;
    discrepancyCount: number;
    firstCollectionAt: Date | null;
    lastCollectionAt: Date | null;
    periodBreakdown: Array<{
      period: string;
      currency: string;
      collectedAmount: unknown;
      expectedAmount: unknown;
      outstandingAmount: unknown;
      count: number;
    }>;
    staffBreakdown: Array<{
      staffId: string;
      staff: {
        id: string;
        firstName: string;
        lastName: string;
        email: string;
      };
      currency: string;
      collectedAmount: unknown;
      expectedAmount: unknown;
      outstandingAmount: unknown;
      count: number;
    }>;
  }): AdminCodReconciliationSummaryDto {
    const dto = new AdminCodReconciliationSummaryDto();
    dto.totalCollections = input.totalCollections;
    dto.totalsByCurrency = input.totalsByCurrency.map((entry) =>
      ReconciliationCurrencyTotalDto.fromEntity(entry),
    );
    dto.expectedAmountByCurrency = input.expectedAmountByCurrency.map((entry) =>
      ExpectedAmountByCurrencyDto.fromEntity(entry),
    );
    dto.outstandingAmountByCurrency = input.outstandingAmountByCurrency.map(
      (entry) => OutstandingAmountByCurrencyDto.fromEntity(entry),
    );
    dto.collectionCount = input.collectionCount;
    dto.discrepancyCount = input.discrepancyCount;
    dto.firstCollectionAt = input.firstCollectionAt;
    dto.lastCollectionAt = input.lastCollectionAt;
    dto.periodBreakdown = input.periodBreakdown.map((entry) =>
      ReconciliationPeriodBreakdownDto.fromEntity(entry),
    );
    dto.staffBreakdown = input.staffBreakdown.map((entry) =>
      ReconciliationStaffBreakdownDto.fromEntity(entry),
    );
    return dto;
  }
}
