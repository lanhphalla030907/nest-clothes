import type {
  FinanceBasis,
  FinanceRankingMetric,
  FinanceTrendGranularity,
} from './finance.constants.js';

/** The reporting window echoed back with every response. */
export interface FinanceRangeResponse {
  from: string;
  to: string;
  basis: FinanceBasis;
  timezone: string;
  currency?: string;
}

/** Revenue and known-cost profit for one currency. */
export interface FinanceOverviewCurrency {
  currency: string;
  orderCount: number;
  grossSales: string;
  productDiscounts: string;
  shippingDiscounts: string;
  totalDiscounts: string;
  shippingRevenue: string;
  netProductRevenue: string;
  netRevenue: string;
  averageOrderValue: string | null;
  cogs: string | null;
  knownCostNetRevenue: string;
  grossProfit: string | null;
  grossMargin: string | null;
  costCoverage: string | null;
  isProfitPartial: boolean;
  discountMismatchCount: number;
  codOrderCount: number;
  onlinePaidOrderCount: number;
}

/** Cash and receivable totals for one currency. */
export interface CashReconciliationCurrency {
  currency: string;
  onlineCash: string;
  codCash: string;
  cashCollected: string;
  orphanCash: string;
  deferredCash: string;
  codReceivable: string;
  unpaidOnline: string;
  accrualRevenue: string;
  reconciliationVariance: string;
  counts: {
    onlinePaidOrders: number;
    codCollectedOrders: number;
    orphanCashOrders: number;
    deferredCashOrders: number;
    codReceivableOrders: number;
    unpaidOnlineOrders: number;
    deliveredOrders: number;
  };
}

export interface FinanceOverviewResponse {
  range: FinanceRangeResponse;
  byCurrency: FinanceOverviewCurrency[];
  cashByCurrency: CashReconciliationCurrency[];
}

export interface RevenueTrendBucket {
  period: string;
  orderCount: number;
  grossSales: string;
  productDiscounts: string;
  shippingDiscounts: string;
  totalDiscounts: string;
  shippingRevenue: string;
  netProductRevenue: string;
  netRevenue: string;
  cogs: string | null;
  knownCostNetRevenue: string;
  grossProfit: string | null;
  grossMargin: string | null;
  costCoverage: string | null;
  isProfitPartial: boolean;
}

export interface RevenueTrendSeries {
  currency: string;
  buckets: RevenueTrendBucket[];
}

export interface RevenueTrendResponse {
  range: FinanceRangeResponse;
  granularity: FinanceTrendGranularity;
  timezone: string;
  series: RevenueTrendSeries[];
}

export interface ProductProfitItem {
  productId: string;
  productName: string;
  variantId: string;
  variantSku: string;
  currency: string;
  orderCount: number;
  unitsSold: number;
  grossRevenue: string;
  productDiscounts: string;
  netRevenue: string;
  cogs: string | null;
  knownCostNetRevenue: string;
  grossProfit: string | null;
  grossMargin: string | null;
  costCoverage: string | null;
  isProfitPartial: boolean;
}

export interface ProductProfitResponse {
  range: FinanceRangeResponse;
  items: ProductProfitItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface ProductRankingItem {
  rank: number;
  productId: string;
  productName: string;
  currency: string;
  unitsSold: number;
  netRevenue: string;
  cogs: string | null;
  grossProfit: string | null;
  grossMargin: string | null;
  costCoverage: string | null;
  isProfitPartial: boolean;
}

export interface ProductRankingsResponse {
  range: FinanceRangeResponse;
  metric: FinanceRankingMetric;
  items: ProductRankingItem[];
}

export interface CashReconciliationResponse {
  range: FinanceRangeResponse;
  byCurrency: CashReconciliationCurrency[];
}
