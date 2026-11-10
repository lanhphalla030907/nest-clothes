import type {
  FinanceCashRow,
  FinanceOverviewRow,
  FinanceProductRow,
  FinanceRankingRow,
  FinanceTrendRow,
} from './finance.repository.js';
import { FinanceRepository } from './finance.repository.js';
import { FinanceService } from './finance.service.js';
import { FinanceQueryDto } from './dto/finance-query.dto.js';
import { ProductProfitQueryDto } from './dto/product-profit-query.dto.js';
import { RankingsQueryDto } from './dto/rankings-query.dto.js';
import { RevenueTrendQueryDto } from './dto/revenue-trend-query.dto.js';
import { CashReconciliationQueryDto } from './dto/cash-reconciliation-query.dto.js';

/**
 * Service-level finance rules with the SQL repository stubbed out.
 *
 * The integration suite proves the aggregation; these tests prove how the
 * service turns nullable `NUMERIC` results into the API contract: money is a
 * string, multi-currency rows stay separate, and missing cost is `null` rather
 * than zero.
 */

function overviewRow(
  overrides: Partial<FinanceOverviewRow> = {},
): FinanceOverviewRow {
  return {
    currency: 'USD',
    order_count: 2,
    gross_sales: '100.00',
    product_discounts: '10.00',
    shipping_discounts: '5.00',
    total_discounts: '15.00',
    shipping_revenue: '5.00',
    net_product_revenue: '90.00',
    net_revenue: '95.00',
    total_line_total: '100.00',
    costed_line_total: '100.00',
    costed_net_revenue: '90.00',
    cogs: '40.00',
    discount_mismatch_count: 0,
    cod_order_count: 1,
    online_paid_order_count: 1,
    ...overrides,
  };
}

function cashRow(overrides: Partial<FinanceCashRow> = {}): FinanceCashRow {
  return {
    currency: 'USD',
    online_cash: '200.00',
    cod_cash: '100.00',
    cash_collected: '300.00',
    orphan_cash: '20.00',
    deferred_cash: '10.00',
    cod_receivable: '30.00',
    unpaid_online: '40.00',
    accrual_revenue: '300.00',
    online_paid_orders: 2,
    cod_collected_orders: 1,
    orphan_cash_orders: 1,
    deferred_cash_orders: 1,
    cod_receivable_orders: 1,
    unpaid_online_orders: 1,
    delivered_orders: 3,
    ...overrides,
  };
}

function trendRow(overrides: Partial<FinanceTrendRow> = {}): FinanceTrendRow {
  return {
    currency: 'USD',
    period: '2026-09-30',
    order_count: 1,
    gross_sales: '11.00',
    product_discounts: '0.00',
    shipping_discounts: '0.00',
    total_discounts: '0.00',
    shipping_revenue: '0.00',
    net_product_revenue: '11.00',
    net_revenue: '11.00',
    total_line_total: '11.00',
    costed_line_total: '11.00',
    costed_net_revenue: '11.00',
    cogs: '1.00',
    ...overrides,
  };
}

function productRow(
  overrides: Partial<FinanceProductRow> = {},
): FinanceProductRow {
  return {
    product_id: 'product-1',
    product_name: 'Product One',
    variant_id: 'variant-1',
    variant_sku: 'SKU-1',
    currency: 'USD',
    order_count: 1,
    units_sold: 2,
    gross_revenue: '100.00',
    product_discounts: '10.00',
    net_revenue: '90.00',
    costed_line_total: '100.00',
    costed_net_revenue: '90.00',
    cogs: '40.00',
    ...overrides,
  };
}

function rankingRow(
  overrides: Partial<FinanceRankingRow> = {},
): FinanceRankingRow {
  return {
    rank: 1,
    product_id: 'product-1',
    product_name: 'Product One',
    currency: 'USD',
    units_sold: 2,
    gross_revenue: '100.00',
    net_revenue: '90.00',
    costed_line_total: '100.00',
    costed_net_revenue: '90.00',
    cogs: '40.00',
    ...overrides,
  };
}

function makeRepository() {
  return {
    getOverview: vi.fn(),
    getRevenueTrend: vi.fn(),
    getProductProfitability: vi.fn(),
    getRankings: vi.fn(),
    getCashReconciliation: vi.fn(),
  };
}

function makeService(repository: ReturnType<typeof makeRepository>) {
  return new FinanceService(repository as unknown as FinanceRepository);
}

const range = { from: '2026-09-01', to: '2026-09-30', currency: 'USD' };

describe('FinanceService', () => {
  it('leaves margin and average order value null when revenue is zero', async () => {
    const repository = makeRepository();
    repository.getOverview.mockResolvedValue([
      overviewRow({
        order_count: 0,
        gross_sales: '0.00',
        product_discounts: '0.00',
        shipping_discounts: '0.00',
        total_discounts: '0.00',
        shipping_revenue: '0.00',
        net_product_revenue: '0.00',
        net_revenue: '0.00',
        total_line_total: '0.00',
        costed_line_total: '0.00',
        costed_net_revenue: '0.00',
        cogs: '0.00',
        discount_mismatch_count: 0,
        cod_order_count: 0,
        online_paid_order_count: 0,
      }),
    ]);
    repository.getCashReconciliation.mockResolvedValue([]);
    const service = makeService(repository);

    const result = await service.getOverview(
      Object.assign(new FinanceQueryDto(), range),
    );
    const usd = result.byCurrency[0];

    expect(usd.averageOrderValue).toBeNull();
    expect(usd.grossProfit).toBe('0.00');
    expect(usd.grossMargin).toBeNull();
    expect(usd.costCoverage).toBeNull();
    expect(usd.isProfitPartial).toBe(true);
  });

  it('keeps each currency in its own row and never adds them together', async () => {
    const repository = makeRepository();
    repository.getOverview.mockResolvedValue([
      overviewRow({ currency: 'KHR', order_count: 1, net_revenue: '40000.00' }),
      overviewRow({ currency: 'USD', order_count: 3, net_revenue: '100.00' }),
    ]);
    repository.getCashReconciliation.mockResolvedValue([
      cashRow({ currency: 'KHR', cash_collected: '40000.00' }),
      cashRow({ currency: 'USD', cash_collected: '300.00' }),
    ]);
    const service = makeService(repository);

    const result = await service.getOverview(
      Object.assign(new FinanceQueryDto(), { from: range.from, to: range.to }),
    );

    expect(result.byCurrency.map((row) => row.currency)).toEqual([
      'KHR',
      'USD',
    ]);
    expect(result.byCurrency.map((row) => row.netRevenue)).toEqual([
      '40000.00',
      '100.00',
    ]);
    expect(result.byCurrency[1].averageOrderValue).toBe('33.33');
    expect(result.cashByCurrency.map((row) => row.cashCollected)).toEqual([
      '40000.00',
      '300.00',
    ]);
  });

  it('marks profit partial and reports coverage when only some lines have cost', async () => {
    const repository = makeRepository();
    repository.getOverview.mockResolvedValue([
      overviewRow({
        total_line_total: '100.00',
        costed_line_total: '50.00',
        costed_net_revenue: '50.00',
        cogs: '30.00',
        net_revenue: '100.00',
      }),
    ]);
    repository.getCashReconciliation.mockResolvedValue([]);
    const service = makeService(repository);

    const usd = (
      await service.getOverview(Object.assign(new FinanceQueryDto(), range))
    ).byCurrency[0];

    expect(usd.costCoverage).toBe('0.5000');
    expect(usd.knownCostNetRevenue).toBe('50.00');
    expect(usd.grossProfit).toBe('20.00');
    expect(usd.grossMargin).toBe('0.4000');
    expect(usd.isProfitPartial).toBe(true);
  });

  it('keeps COGS and profit unknown when no line has a comparable cost', async () => {
    const repository = makeRepository();
    repository.getOverview.mockResolvedValue([
      overviewRow({
        total_line_total: '100.00',
        costed_line_total: '0.00',
        costed_net_revenue: '0.00',
        cogs: null,
      }),
    ]);
    repository.getCashReconciliation.mockResolvedValue([]);
    const service = makeService(repository);

    const usd = (
      await service.getOverview(Object.assign(new FinanceQueryDto(), range))
    ).byCurrency[0];

    expect(usd.cogs).toBeNull();
    expect(usd.knownCostNetRevenue).toBe('0.00');
    expect(usd.grossProfit).toBeNull();
    expect(usd.grossMargin).toBeNull();
    expect(usd.costCoverage).toBe('0.0000');
    expect(usd.isProfitPartial).toBe(true);
  });

  it('reports cash variance rather than plugging it', async () => {
    const repository = makeRepository();
    repository.getOverview.mockResolvedValue([]);
    repository.getCashReconciliation.mockResolvedValue([
      cashRow({
        cash_collected: '300.00',
        deferred_cash: '10.00',
        orphan_cash: '20.00',
        cod_receivable: '30.00',
        accrual_revenue: '300.00',
      }),
    ]);
    const service = makeService(repository);

    const usd = (
      await service.getCashReconciliation(
        Object.assign(new CashReconciliationQueryDto(), {
          from: range.from,
          to: range.to,
        }),
      )
    ).byCurrency[0];

    // 300 - 10 - 20 + 30 = 300, so the books reconcile.
    expect(usd.reconciliationVariance).toBe('0.00');

    repository.getCashReconciliation.mockResolvedValue([
      cashRow({
        cash_collected: '300.00',
        deferred_cash: '10.00',
        orphan_cash: '20.00',
        cod_receivable: '30.00',
        accrual_revenue: '301.50',
      }),
    ]);
    const drifted = (
      await service.getCashReconciliation(
        Object.assign(new CashReconciliationQueryDto(), {
          from: range.from,
          to: range.to,
        }),
      )
    ).byCurrency[0];

    expect(drifted.reconciliationVariance).toBe('1.50');
  });

  it('delegates resolved defaults to the repository', async () => {
    const repository = makeRepository();
    repository.getRevenueTrend.mockResolvedValue([
      trendRow({ currency: 'USD', period: '2026-09-30' }),
      trendRow({ currency: 'USD', period: '2026-10-01' }),
      trendRow({ currency: 'KHR', period: '2026-09-30' }),
    ]);
    repository.getProductProfitability.mockResolvedValue({
      rows: [productRow()],
      total: 21,
    });
    repository.getRankings.mockResolvedValue([rankingRow()]);
    repository.getCashReconciliation.mockResolvedValue([cashRow()]);
    const service = makeService(repository);

    const trend = await service.getRevenueTrend(
      Object.assign(new RevenueTrendQueryDto(), range),
    );
    expect(repository.getRevenueTrend).toHaveBeenCalledWith(
      expect.objectContaining({
        from: '2026-09-01',
        to: '2026-09-30',
        currency: 'USD',
        basis: 'delivered',
        granularity: 'day',
      }),
    );
    expect(trend.granularity).toBe('day');
    expect(trend.timezone).toBe('Asia/Phnom_Penh');
    expect(trend.series.map((series) => series.currency)).toEqual([
      'USD',
      'KHR',
    ]);
    expect(trend.series[0].buckets.map((bucket) => bucket.period)).toEqual([
      '2026-09-30',
      '2026-10-01',
    ]);

    const products = await service.getProductProfitability(
      Object.assign(new ProductProfitQueryDto(), range),
    );
    expect(repository.getProductProfitability).toHaveBeenCalledWith(
      expect.objectContaining({
        page: 1,
        limit: 20,
        sortBy: 'revenue',
        sortOrder: 'desc',
      }),
    );
    expect(products.pagination).toEqual({
      page: 1,
      limit: 20,
      total: 21,
      totalPages: 2,
    });

    const rankings = await service.getRankings(
      Object.assign(new RankingsQueryDto(), {
        from: range.from,
        to: range.to,
      }),
    );
    expect(repository.getRankings).toHaveBeenCalledWith(
      expect.objectContaining({ metric: 'revenue', limit: 10 }),
    );
    expect(rankings.metric).toBe('revenue');
    expect(rankings.items[0].rank).toBe(1);
  });

  it('echoes the currency filter only when one was requested', async () => {
    const repository = makeRepository();
    repository.getOverview.mockResolvedValue([]);
    repository.getCashReconciliation.mockResolvedValue([]);
    const service = makeService(repository);

    const filtered = await service.getOverview(
      Object.assign(new FinanceQueryDto(), range),
    );
    const all = await service.getOverview(
      Object.assign(new FinanceQueryDto(), {
        from: range.from,
        to: range.to,
      }),
    );

    expect(filtered.range.currency).toBe('USD');
    expect(all.range.currency).toBeUndefined();
  });
});
