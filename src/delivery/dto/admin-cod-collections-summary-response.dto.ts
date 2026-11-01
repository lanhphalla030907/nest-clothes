import { toMoneyString } from '../../common/utils/money.js';

/**
 * One currency-scoped total within an administrative collection summary.
 */
export class CurrencyTotalDto {
  currency: string;
  totalAmount: string;
  count: number;

  static fromEntity(entity: {
    currency: string;
    totalAmount: unknown;
    count: number;
  }): CurrencyTotalDto {
    const dto = new CurrencyTotalDto();
    dto.currency = entity.currency;
    dto.totalAmount = toMoneyString(entity.totalAmount);
    dto.count = entity.count;
    return dto;
  }
}

/** One period-scoped row within an administrative collection summary. */
export class PeriodBreakdownDto {
  period: string;
  currency: string;
  totalAmount: string;
  count: number;

  static fromEntity(entity: {
    period: string;
    currency: string;
    totalAmount: unknown;
    count: number;
  }): PeriodBreakdownDto {
    const dto = new PeriodBreakdownDto();
    dto.period = entity.period;
    dto.currency = entity.currency;
    dto.totalAmount = toMoneyString(entity.totalAmount);
    dto.count = entity.count;
    return dto;
  }
}

/** One staff-member row within an administrative collection summary. */
export class StaffBreakdownDto {
  staffId: string;
  staff: { id: string; firstName: string; lastName: string; email: string };
  currency: string;
  totalAmount: string;
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
    totalAmount: unknown;
    count: number;
  }): StaffBreakdownDto {
    const dto = new StaffBreakdownDto();
    dto.staffId = entity.staffId;
    dto.staff = entity.staff;
    dto.currency = entity.currency;
    dto.totalAmount = toMoneyString(entity.totalAmount);
    dto.count = entity.count;
    return dto;
  }
}

/**
 * The administrative COD collection summary.
 *
 * Amounts are aggregated per currency and never mixed: `totalsByCurrency` is
 * authoritative, and every `periodBreakdown`/`staffBreakdown` row keeps its own
 * currency so mixed-currency periods and staff stay separated.
 */
export class AdminCodCollectionsSummaryResponseDto {
  totalCollections: number;
  totalsByCurrency: CurrencyTotalDto[];
  firstCollectionAt: Date | null;
  lastCollectionAt: Date | null;
  periodBreakdown: PeriodBreakdownDto[];
  staffBreakdown: StaffBreakdownDto[];

  static fromEntity(input: {
    totalCollections: number;
    totalsByCurrency: Array<{
      currency: string;
      totalAmount: unknown;
      count: number;
    }>;
    firstCollectionAt: Date | null;
    lastCollectionAt: Date | null;
    periodBreakdown: Array<{
      period: string;
      currency: string;
      totalAmount: unknown;
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
      totalAmount: unknown;
      count: number;
    }>;
  }): AdminCodCollectionsSummaryResponseDto {
    const dto = new AdminCodCollectionsSummaryResponseDto();
    dto.totalCollections = input.totalCollections;
    dto.totalsByCurrency = input.totalsByCurrency.map((entry) =>
      CurrencyTotalDto.fromEntity(entry),
    );
    dto.firstCollectionAt = input.firstCollectionAt;
    dto.lastCollectionAt = input.lastCollectionAt;
    dto.periodBreakdown = input.periodBreakdown.map((entry) =>
      PeriodBreakdownDto.fromEntity(entry),
    );
    dto.staffBreakdown = input.staffBreakdown.map((entry) =>
      StaffBreakdownDto.fromEntity(entry),
    );
    return dto;
  }
}
