import { Injectable } from '@nestjs/common';
import type { CashReconciliationQueryDto } from './dto/cash-reconciliation-query.dto.js';
import type { FinanceQueryDto } from './dto/finance-query.dto.js';
import type { ProductProfitQueryDto } from './dto/product-profit-query.dto.js';
import type { RankingsQueryDto } from './dto/rankings-query.dto.js';
import type { RevenueTrendQueryDto } from './dto/revenue-trend-query.dto.js';
import {
  FINANCE_DEFAULT_GRANULARITY,
  FINANCE_DEFAULT_PAGE_SIZE,
  FINANCE_DEFAULT_RANKING_LIMIT,
  type FinanceBasis,
  type FinanceRankingMetric,
  type FinanceTrendGranularity,
} from './finance.constants.js';
import {
  FinanceRepository,
  type FinanceCashRow,
  type FinanceOverviewRow,
  type FinanceProductRow,
  type FinanceRankingRow,
  type FinanceTrendRow,
} from './finance.repository.js';
import type {
  CashReconciliationCurrency,
  CashReconciliationResponse,
  FinanceOverviewCurrency,
  FinanceOverviewResponse,
  FinanceRangeResponse,
  ProductProfitItem,
  ProductProfitResponse,
  ProductRankingItem,
  ProductRankingsResponse,
  RevenueTrendBucket,
  RevenueTrendResponse,
} from './finance.types.js';
import {
  grossProfitFromKnownCost,
  isCoveragePartial,
  resolveFinanceRange,
  serializeMoney,
  serializeNullableMoney,
  serializeRatio,
  toDecimal,
  toNullableDecimal,
  type ResolvedFinanceRange,
} from './finance.utils.js';

/**
 * Finance reporting service.
 *
 * The repository does the aggregation in PostgreSQL; this service only resolves
 * the reporting window, converts `NUMERIC` results into exact `Decimal` values,
 * and serialises them as strings. No money is summed here.
 *
 * ## Profit is known-cost only
 *
 * A line with a missing or mismatched cost snapshot is not a zero-cost line. It
 * is excluded from COGS and from known-cost revenue, and `costCoverage` says how
 * much of the merchandise revenue that leaves. When coverage is below 100% the
 * profit figure is marked partial; when no line has a comparable cost, profit and
 * margin are `null`, never `0`.
 */
@Injectable()
export class FinanceService {
  constructor(private readonly repository: FinanceRepository) {}

  async getOverview(query: FinanceQueryDto): Promise<FinanceOverviewResponse> {
    const range = resolveFinanceRange(query);
    const [overviewRows, cashRows] = await Promise.all([
      this.repository.getOverview(range),
      this.repository.getCashReconciliation(range),
    ]);

    return {
      range: this.toRangeResponse(range),
      byCurrency: overviewRows.map((row) => this.mapOverview(row)),
      cashByCurrency: cashRows.map((row) => this.mapCash(row)),
    };
  }

  async getRevenueTrend(
    query: RevenueTrendQueryDto,
  ): Promise<RevenueTrendResponse> {
    const range = resolveFinanceRange(query);
    const granularity: FinanceTrendGranularity =
      query.granularity ?? FINANCE_DEFAULT_GRANULARITY;
    const rows = await this.repository.getRevenueTrend({
      ...range,
      granularity,
    });

    const series = new Map<string, RevenueTrendBucket[]>();
    for (const row of rows) {
      const bucket = this.mapTrendBucket(row);
      const buckets = series.get(row.currency);
      if (buckets) {
        buckets.push(bucket);
      } else {
        series.set(row.currency, [bucket]);
      }
    }

    return {
      range: this.toRangeResponse(range),
      granularity,
      timezone: range.timezone,
      series: [...series.entries()].map(([currency, buckets]) => ({
        currency,
        buckets,
      })),
    };
  }

  async getProductProfitability(
    query: ProductProfitQueryDto,
  ): Promise<ProductProfitResponse> {
    const range = resolveFinanceRange(query);
    const page = query.page ?? 1;
    const limit = query.limit ?? FINANCE_DEFAULT_PAGE_SIZE;
    const sortBy = query.sortBy ?? 'revenue';
    const sortOrder = query.sortOrder ?? 'desc';

    const { rows, total } = await this.repository.getProductProfitability({
      ...range,
      page,
      limit,
      sortBy,
      sortOrder,
    });

    return {
      range: this.toRangeResponse(range),
      items: rows.map((row) => this.mapProduct(row)),
      pagination: {
        page,
        limit,
        total,
        totalPages: limit > 0 ? Math.ceil(total / limit) : 0,
      },
    };
  }

  async getRankings(query: RankingsQueryDto): Promise<ProductRankingsResponse> {
    const range = resolveFinanceRange(query);
    const metric: FinanceRankingMetric = query.metric ?? 'revenue';
    const limit = query.limit ?? FINANCE_DEFAULT_RANKING_LIMIT;
    const rows = await this.repository.getRankings({ ...range, metric, limit });

    return {
      range: this.toRangeResponse(range),
      metric,
      items: rows.map((row) => this.mapRanking(row)),
    };
  }

  async getCashReconciliation(
    query: CashReconciliationQueryDto,
  ): Promise<CashReconciliationResponse> {
    const range = resolveFinanceRange(query);
    const rows = await this.repository.getCashReconciliation(range);

    return {
      range: this.toRangeResponse(range),
      byCurrency: rows.map((row) => this.mapCash(row)),
    };
  }

  private toRangeResponse(range: ResolvedFinanceRange): FinanceRangeResponse {
    return {
      from: range.from,
      to: range.to,
      basis: range.basis as FinanceBasis,
      timezone: range.timezone,
      ...(range.currency ? { currency: range.currency } : {}),
    };
  }

  private mapOverview(row: FinanceOverviewRow): FinanceOverviewCurrency {
    const orderCount = Number(row.order_count);
    const netRevenue = toDecimal(row.net_revenue);
    const profit = this.profitFields(
      row.cogs,
      row.costed_net_revenue,
      row.costed_line_total,
      row.total_line_total,
    );

    return {
      currency: row.currency,
      orderCount,
      grossSales: serializeMoney(row.gross_sales),
      productDiscounts: serializeMoney(row.product_discounts),
      shippingDiscounts: serializeMoney(row.shipping_discounts),
      totalDiscounts: serializeMoney(row.total_discounts),
      shippingRevenue: serializeMoney(row.shipping_revenue),
      netProductRevenue: serializeMoney(row.net_product_revenue),
      netRevenue: serializeMoney(netRevenue),
      averageOrderValue:
        orderCount > 0
          ? netRevenue.div(orderCount).toDecimalPlaces(2).toFixed(2)
          : null,
      discountMismatchCount: Number(row.discount_mismatch_count),
      codOrderCount: Number(row.cod_order_count),
      onlinePaidOrderCount: Number(row.online_paid_order_count),
      ...profit,
    };
  }

  private mapTrendBucket(row: FinanceTrendRow): RevenueTrendBucket {
    const profit = this.profitFields(
      row.cogs,
      row.costed_net_revenue,
      row.costed_line_total,
      row.total_line_total,
    );

    return {
      period: row.period,
      orderCount: Number(row.order_count),
      grossSales: serializeMoney(row.gross_sales),
      productDiscounts: serializeMoney(row.product_discounts),
      shippingDiscounts: serializeMoney(row.shipping_discounts),
      totalDiscounts: serializeMoney(row.total_discounts),
      shippingRevenue: serializeMoney(row.shipping_revenue),
      netProductRevenue: serializeMoney(row.net_product_revenue),
      netRevenue: serializeMoney(row.net_revenue),
      ...profit,
    };
  }

  private mapProduct(row: FinanceProductRow): ProductProfitItem {
    const profit = this.profitFields(
      row.cogs,
      row.costed_net_revenue,
      row.costed_line_total,
      row.gross_revenue,
    );

    return {
      productId: row.product_id,
      productName: row.product_name,
      variantId: row.variant_id,
      variantSku: row.variant_sku,
      currency: row.currency,
      orderCount: Number(row.order_count),
      unitsSold: Number(row.units_sold),
      grossRevenue: serializeMoney(row.gross_revenue),
      productDiscounts: serializeMoney(row.product_discounts),
      netRevenue: serializeMoney(row.net_revenue),
      ...profit,
    };
  }

  private mapRanking(row: FinanceRankingRow): ProductRankingItem {
    const profit = this.profitFields(
      row.cogs,
      row.costed_net_revenue,
      row.costed_line_total,
      row.gross_revenue,
    );

    return {
      rank: Number(row.rank),
      productId: row.product_id,
      productName: row.product_name,
      currency: row.currency,
      unitsSold: Number(row.units_sold),
      netRevenue: serializeMoney(row.net_revenue),
      ...profit,
    };
  }

  private mapCash(row: FinanceCashRow): CashReconciliationCurrency {
    const cashCollected = toDecimal(row.cash_collected);
    const deferredCash = toDecimal(row.deferred_cash);
    const orphanCash = toDecimal(row.orphan_cash);
    const codReceivable = toDecimal(row.cod_receivable);
    const accrualRevenue = toDecimal(row.accrual_revenue);

    // Accrual revenue should equal cash collected, minus cash collected for
    // orders that are not delivered yet, minus cash on cancelled orders, plus
    // delivered COD that has not been collected. A non-zero result is reported,
    // never plugged.
    const expectedAccrual = cashCollected
      .minus(deferredCash)
      .minus(orphanCash)
      .plus(codReceivable);

    return {
      currency: row.currency,
      onlineCash: serializeMoney(row.online_cash),
      codCash: serializeMoney(row.cod_cash),
      cashCollected: serializeMoney(cashCollected),
      orphanCash: serializeMoney(orphanCash),
      deferredCash: serializeMoney(deferredCash),
      codReceivable: serializeMoney(codReceivable),
      unpaidOnline: serializeMoney(row.unpaid_online),
      accrualRevenue: serializeMoney(accrualRevenue),
      reconciliationVariance: accrualRevenue.minus(expectedAccrual).toFixed(2),
      counts: {
        onlinePaidOrders: Number(row.online_paid_orders),
        codCollectedOrders: Number(row.cod_collected_orders),
        orphanCashOrders: Number(row.orphan_cash_orders),
        deferredCashOrders: Number(row.deferred_cash_orders),
        codReceivableOrders: Number(row.cod_receivable_orders),
        unpaidOnlineOrders: Number(row.unpaid_online_orders),
        deliveredOrders: Number(row.delivered_orders),
      },
    };
  }

  /**
   * The profit fields shared by every revenue row.
   *
   * `cogs` is `null` when no line had a comparable cost snapshot. In that case
   * profit and margin are unknown; they are not revenue minus zero.
   */
  private profitFields(
    cogs: unknown,
    knownCostNetRevenue: unknown,
    costedLineTotal: unknown,
    totalLineTotal: unknown,
  ): Pick<
    FinanceOverviewCurrency,
    | 'cogs'
    | 'knownCostNetRevenue'
    | 'grossProfit'
    | 'grossMargin'
    | 'costCoverage'
    | 'isProfitPartial'
  > {
    const cost = toNullableDecimal(cogs);
    const knownRevenue = toDecimal(knownCostNetRevenue);
    const coverage = serializeRatio(costedLineTotal, totalLineTotal);
    const grossProfit = grossProfitFromKnownCost(knownRevenue, cost);
    const grossMargin =
      cost === null ? null : serializeRatio(grossProfit, knownRevenue);

    return {
      cogs: serializeNullableMoney(cost),
      knownCostNetRevenue: serializeMoney(knownRevenue),
      grossProfit,
      grossMargin,
      costCoverage: coverage,
      isProfitPartial: cost === null || isCoveragePartial(coverage),
    };
  }
}
