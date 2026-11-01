import { toMoneyString } from '../../common/utils/money.js';

/** One currency-scoped total within a collection summary. */
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

/** One period-scoped row within a collection summary breakdown. */
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

/**
 * Outbound representation of `GET /delivery/staff/cod-collections/summary`.
 *
 * Amounts are never aggregated across currencies: `totalsByCurrency` carries the
 * authoritative per-currency breakdown, and each `periodBreakdown` row keeps its
 * own currency so mixed-currency periods stay separated. There is deliberately no
 * single top-level money total, because adding amounts in different currencies
 * would be meaningless.
 */
export class CodCollectionsSummaryResponseDto {
  totalCollections: number;
  totalsByCurrency: CurrencyTotalDto[];
  firstCollectionAt: Date | null;
  lastCollectionAt: Date | null;
  periodBreakdown: PeriodBreakdownDto[];

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
  }): CodCollectionsSummaryResponseDto {
    const dto = new CodCollectionsSummaryResponseDto();
    dto.totalCollections = input.totalCollections;
    dto.totalsByCurrency = input.totalsByCurrency.map((entry) =>
      CurrencyTotalDto.fromEntity(entry),
    );
    dto.firstCollectionAt = input.firstCollectionAt;
    dto.lastCollectionAt = input.lastCollectionAt;
    dto.periodBreakdown = input.periodBreakdown.map((entry) =>
      PeriodBreakdownDto.fromEntity(entry),
    );
    return dto;
  }
}
