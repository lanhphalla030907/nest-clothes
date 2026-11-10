import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import {
  FREE_SHIPPING_DISCOUNT_TYPE,
  type FinanceProductSortBy,
  type FinanceRankingMetric,
  type FinanceSortOrder,
  type FinanceTrendGranularity,
} from './finance.constants.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ResolvedFinanceRange } from './finance.utils.js';

type Numeric = Prisma.Decimal | string | number | null;
type Count = bigint | number;

/** One currency's revenue and profit totals for the overview. */
export interface FinanceOverviewRow {
  currency: string;
  order_count: Count;
  gross_sales: Numeric;
  product_discounts: Numeric;
  shipping_discounts: Numeric;
  total_discounts: Numeric;
  shipping_revenue: Numeric;
  net_product_revenue: Numeric;
  net_revenue: Numeric;
  total_line_total: Numeric;
  costed_line_total: Numeric;
  costed_net_revenue: Numeric;
  cogs: Numeric;
  discount_mismatch_count: Count;
  cod_order_count: Count;
  online_paid_order_count: Count;
}

/** One bucket in a revenue trend series. */
export interface FinanceTrendRow {
  currency: string;
  period: string;
  order_count: Count;
  gross_sales: Numeric;
  product_discounts: Numeric;
  shipping_discounts: Numeric;
  total_discounts: Numeric;
  shipping_revenue: Numeric;
  net_product_revenue: Numeric;
  net_revenue: Numeric;
  total_line_total: Numeric;
  costed_line_total: Numeric;
  costed_net_revenue: Numeric;
  cogs: Numeric;
}

/** One product/variant row in the profitability listing. */
export interface FinanceProductRow {
  product_id: string;
  product_name: string;
  variant_id: string;
  variant_sku: string;
  currency: string;
  order_count: Count;
  units_sold: Count;
  gross_revenue: Numeric;
  product_discounts: Numeric;
  net_revenue: Numeric;
  costed_line_total: Numeric;
  costed_net_revenue: Numeric;
  cogs: Numeric;
}

/** One ranked product. */
export interface FinanceRankingRow {
  rank: Count;
  product_id: string;
  product_name: string;
  currency: string;
  units_sold: Count;
  gross_revenue: Numeric;
  net_revenue: Numeric;
  costed_line_total: Numeric;
  costed_net_revenue: Numeric;
  cogs: Numeric;
}

/** One currency's cash and receivable totals. */
export interface FinanceCashRow {
  currency: string;
  online_cash: Numeric;
  cod_cash: Numeric;
  cash_collected: Numeric;
  orphan_cash: Numeric;
  deferred_cash: Numeric;
  cod_receivable: Numeric;
  unpaid_online: Numeric;
  accrual_revenue: Numeric;
  online_paid_orders: Count;
  cod_collected_orders: Count;
  orphan_cash_orders: Count;
  deferred_cash_orders: Count;
  cod_receivable_orders: Count;
  unpaid_online_orders: Count;
  delivered_orders: Count;
}

export interface ProductProfitFilters extends ResolvedFinanceRange {
  page: number;
  limit: number;
  sortBy: FinanceProductSortBy;
  sortOrder: FinanceSortOrder;
}

export interface RankingFilters extends ResolvedFinanceRange {
  metric: FinanceRankingMetric;
  limit: number;
}

export interface TrendFilters extends ResolvedFinanceRange {
  granularity: FinanceTrendGranularity;
}

/**
 * Read-only financial aggregation.
 *
 * Every cross-table figure is calculated by PostgreSQL over `NUMERIC` columns.
 * No money value is summed in JavaScript, and no join is allowed to fan out: the
 * order set is first reduced to one row per order, and only then joined to the
 * line-level allocation. That ordering is what keeps a reassigned delivery or a
 * second payment attempt from multiplying revenue.
 */
@Injectable()
export class FinanceRepository {
  constructor(private readonly prisma: PrismaService) {}

  async getOverview(
    filters: ResolvedFinanceRange,
  ): Promise<FinanceOverviewRow[]> {
    return this.prisma.$queryRaw<FinanceOverviewRow[]>(Prisma.sql`
      WITH ${this.revenueCtes(filters)}
      SELECT
        eo."currency",
        COUNT(DISTINCT eo."order_id") AS order_count,
        COALESCE(SUM(eo."subtotal"), 0) AS gross_sales,
        COALESCE(SUM(eo."product_discount"), 0) AS product_discounts,
        COALESCE(SUM(eo."shipping_discount"), 0) AS shipping_discounts,
        COALESCE(SUM(eo."discount_amount"), 0) AS total_discounts,
        COALESCE(SUM(eo."shipping_revenue"), 0) AS shipping_revenue,
        COALESCE(SUM(eo."net_product_revenue"), 0) AS net_product_revenue,
        COALESCE(SUM(eo."total_amount"), 0) AS net_revenue,
        COALESCE(SUM(lt."total_line_total"), 0) AS total_line_total,
        COALESCE(SUM(lt."costed_line_total"), 0) AS costed_line_total,
        COALESCE(SUM(lt."costed_net_revenue"), 0) AS costed_net_revenue,
        SUM(lt."cogs") AS cogs,
        COUNT(*) FILTER (WHERE eo."discount_mismatch") AS discount_mismatch_count,
        COUNT(*) FILTER (WHERE eo."is_cod_order") AS cod_order_count,
        COUNT(*) FILTER (WHERE eo."online_paid") AS online_paid_order_count
      FROM eligible_orders eo
      LEFT JOIN line_totals lt ON lt."order_id" = eo."order_id"
      GROUP BY eo."currency"
      ORDER BY eo."currency"
    `);
  }

  async getRevenueTrend(filters: TrendFilters): Promise<FinanceTrendRow[]> {
    return this.prisma.$queryRaw<FinanceTrendRow[]>(Prisma.sql`
      WITH ${this.revenueCtes(filters)}
      SELECT
        eo."currency",
        to_char(
          date_trunc(
            ${filters.granularity},
            eo."event_at" AT TIME ZONE 'Asia/Phnom_Penh'
          ),
          'YYYY-MM-DD'
        ) AS period,
        COUNT(DISTINCT eo."order_id") AS order_count,
        COALESCE(SUM(eo."subtotal"), 0) AS gross_sales,
        COALESCE(SUM(eo."product_discount"), 0) AS product_discounts,
        COALESCE(SUM(eo."shipping_discount"), 0) AS shipping_discounts,
        COALESCE(SUM(eo."discount_amount"), 0) AS total_discounts,
        COALESCE(SUM(eo."shipping_revenue"), 0) AS shipping_revenue,
        COALESCE(SUM(eo."net_product_revenue"), 0) AS net_product_revenue,
        COALESCE(SUM(eo."total_amount"), 0) AS net_revenue,
        COALESCE(SUM(lt."total_line_total"), 0) AS total_line_total,
        COALESCE(SUM(lt."costed_line_total"), 0) AS costed_line_total,
        COALESCE(SUM(lt."costed_net_revenue"), 0) AS costed_net_revenue,
        SUM(lt."cogs") AS cogs
      FROM eligible_orders eo
      LEFT JOIN line_totals lt ON lt."order_id" = eo."order_id"
      GROUP BY eo."currency", period
      ORDER BY eo."currency", period
    `);
  }

  async getProductProfitability(
    filters: ProductProfitFilters,
  ): Promise<{ rows: FinanceProductRow[]; total: number }> {
    const sortExpression = this.productSortExpression(filters.sortBy);
    const direction = Prisma.raw(filters.sortOrder === 'asc' ? 'ASC' : 'DESC');
    const offset = (filters.page - 1) * filters.limit;
    const ctes = this.productTotalsCtes(filters);

    const countRows = await this.prisma.$queryRaw<
      Array<{ total: Count }>
    >(Prisma.sql`
      WITH ${ctes}
      SELECT COUNT(*) AS total FROM product_totals
    `);

    const rows = await this.prisma.$queryRaw<FinanceProductRow[]>(Prisma.sql`
      WITH ${ctes}
      SELECT product_totals.*
      FROM product_totals
      ORDER BY
        currency ASC,
        ${sortExpression} ${direction} NULLS LAST,
        product_id ASC,
        variant_id ASC
      LIMIT ${filters.limit} OFFSET ${offset}
    `);

    return {
      rows,
      total: Number(countRows[0]?.total ?? 0),
    };
  }

  async getRankings(filters: RankingFilters): Promise<FinanceRankingRow[]> {
    const metricExpression = this.rankingMetricExpression(filters.metric);

    return this.prisma.$queryRaw<FinanceRankingRow[]>(Prisma.sql`
      WITH ${this.revenueCtes(filters)},
      product_totals AS (
        SELECT
          p."id" AS product_id,
          p."name" AS product_name,
          lf."order_currency" AS currency,
          SUM(lf."quantity") AS units_sold,
          SUM(lf."line_total") AS gross_revenue,
          SUM(lf."net_line_revenue") AS net_revenue,
          SUM(lf."costed_line_total") AS costed_line_total,
          SUM(lf."costed_net_revenue") AS costed_net_revenue,
          SUM(lf."line_cogs") AS cogs
        FROM line_finance lf
        JOIN "product_variants" pv ON pv."id" = lf."variant_id"
        JOIN "products" p ON p."id" = pv."product_id"
        GROUP BY p."id", p."name", lf."order_currency"
      ),
      ranked AS (
        SELECT
          product_totals.*,
          ROW_NUMBER() OVER (
            PARTITION BY currency
            ORDER BY ${metricExpression} DESC NULLS LAST, product_id ASC
          ) AS rank
        FROM product_totals
      )
      SELECT *
      FROM ranked
      WHERE rank <= ${filters.limit}
      ORDER BY currency ASC, rank ASC
    `);
  }

  async getCashReconciliation(
    filters: ResolvedFinanceRange,
  ): Promise<FinanceCashRow[]> {
    const currency = filters.currency;
    const cashCurrencyFilter = currency
      ? Prisma.sql`AND cf."cash_currency" = ${currency}`
      : Prisma.empty;
    const orderCurrencyFilter = currency
      ? Prisma.sql`AND of."currency" = ${currency}`
      : Prisma.empty;

    return this.prisma.$queryRaw<FinanceCashRow[]>(Prisma.sql`
      WITH ${this.orderFactCtes()},
      cash_facts AS (
        SELECT
          of.*,
          CASE
            WHEN of."cod_collected" THEN of."cod_collected_amount"
            WHEN of."online_paid" THEN of."online_paid_amount"
            ELSE 0
          END AS cash_amount,
          CASE
            WHEN of."cod_collected" THEN of."cod_collected_at"
            WHEN of."online_paid" THEN of."online_paid_at"
            ELSE NULL
          END AS cash_event_at,
          COALESCE(
            of."cod_collection_currency",
            of."online_paid_currency",
            of."currency"
          ) AS cash_currency
        FROM order_facts of
      ),
      cash_totals AS (
        SELECT
          cf."cash_currency" AS currency,
          COALESCE(SUM(
            CASE WHEN cf."online_paid"
              AND cf."online_paid_at" >= ${filters.fromUtc}
              AND cf."online_paid_at" < ${filters.toExclusiveUtc}
            THEN cf."online_paid_amount" ELSE 0 END
          ), 0) AS online_cash,
          COALESCE(SUM(
            CASE WHEN cf."cod_collected"
              AND cf."cod_collected_at" >= ${filters.fromUtc}
              AND cf."cod_collected_at" < ${filters.toExclusiveUtc}
            THEN cf."cod_collected_amount" ELSE 0 END
          ), 0) AS cod_cash,
          COALESCE(SUM(
            CASE WHEN cf."cash_event_at" >= ${filters.fromUtc}
              AND cf."cash_event_at" < ${filters.toExclusiveUtc}
            THEN cf."cash_amount" ELSE 0 END
          ), 0) AS cash_collected,
          COALESCE(SUM(
            CASE WHEN cf."cash_event_at" >= ${filters.fromUtc}
              AND cf."cash_event_at" < ${filters.toExclusiveUtc}
              AND cf."status" = 'CANCELLED'
            THEN cf."cash_amount" ELSE 0 END
          ), 0) AS orphan_cash,
          COALESCE(SUM(
            CASE WHEN cf."cash_event_at" >= ${filters.fromUtc}
              AND cf."cash_event_at" < ${filters.toExclusiveUtc}
              AND cf."status" NOT IN ('DELIVERED', 'CANCELLED')
            THEN cf."cash_amount" ELSE 0 END
          ), 0) AS deferred_cash,
          COUNT(*) FILTER (
            WHERE cf."online_paid"
              AND cf."online_paid_at" >= ${filters.fromUtc}
              AND cf."online_paid_at" < ${filters.toExclusiveUtc}
          ) AS online_paid_orders,
          COUNT(*) FILTER (
            WHERE cf."cod_collected"
              AND cf."cod_collected_at" >= ${filters.fromUtc}
              AND cf."cod_collected_at" < ${filters.toExclusiveUtc}
          ) AS cod_collected_orders,
          COUNT(*) FILTER (
            WHERE cf."cash_event_at" >= ${filters.fromUtc}
              AND cf."cash_event_at" < ${filters.toExclusiveUtc}
              AND cf."status" = 'CANCELLED'
          ) AS orphan_cash_orders,
          COUNT(*) FILTER (
            WHERE cf."cash_event_at" >= ${filters.fromUtc}
              AND cf."cash_event_at" < ${filters.toExclusiveUtc}
              AND cf."status" NOT IN ('DELIVERED', 'CANCELLED')
          ) AS deferred_cash_orders
        FROM cash_facts cf
        WHERE true ${cashCurrencyFilter}
        GROUP BY cf."cash_currency"
      ),
      receivables AS (
        SELECT
          of."currency",
          COALESCE(SUM(
            CASE WHEN of."status" = 'DELIVERED'
              AND of."delivered_at" >= ${filters.fromUtc}
              AND of."delivered_at" < ${filters.toExclusiveUtc}
              AND (of."payment_method" = 'COD' OR of."payment_method" IS NULL)
              AND NOT of."cod_collected"
              AND NOT of."online_paid"
            THEN of."total_amount" ELSE 0 END
          ), 0) AS cod_receivable,
          COALESCE(SUM(
            CASE WHEN of."status" <> 'CANCELLED'
              AND of."payment_method" IS DISTINCT FROM 'COD'
              AND NOT of."online_paid"
              AND NOT of."cod_collected"
              AND of."created_at" >= ${filters.fromUtc}
              AND of."created_at" < ${filters.toExclusiveUtc}
            THEN of."total_amount" ELSE 0 END
          ), 0) AS unpaid_online,
          COUNT(*) FILTER (
            WHERE of."status" = 'DELIVERED'
              AND of."delivered_at" >= ${filters.fromUtc}
              AND of."delivered_at" < ${filters.toExclusiveUtc}
              AND (of."payment_method" = 'COD' OR of."payment_method" IS NULL)
              AND NOT of."cod_collected"
              AND NOT of."online_paid"
          ) AS cod_receivable_orders,
          COUNT(*) FILTER (
            WHERE of."status" <> 'CANCELLED'
              AND of."payment_method" IS DISTINCT FROM 'COD'
              AND NOT of."online_paid"
              AND NOT of."cod_collected"
              AND of."created_at" >= ${filters.fromUtc}
              AND of."created_at" < ${filters.toExclusiveUtc}
          ) AS unpaid_online_orders
        FROM order_facts of
        WHERE true ${orderCurrencyFilter}
        GROUP BY of."currency"
      ),
      delivered_revenue AS (
        SELECT
          of."currency",
          COALESCE(SUM(of."total_amount"), 0) AS accrual_revenue,
          COUNT(*) AS delivered_orders
        FROM order_facts of
        WHERE of."delivered_sale"
          AND of."delivered_at" >= ${filters.fromUtc}
          AND of."delivered_at" < ${filters.toExclusiveUtc}
          ${orderCurrencyFilter}
        GROUP BY of."currency"
      ),
      currency_totals AS (
        SELECT currency FROM cash_totals
        UNION
        SELECT currency FROM receivables
        UNION
        SELECT currency FROM delivered_revenue
      )
      SELECT
        ct."currency",
        COALESCE(c."online_cash", 0) AS online_cash,
        COALESCE(c."cod_cash", 0) AS cod_cash,
        COALESCE(c."cash_collected", 0) AS cash_collected,
        COALESCE(c."orphan_cash", 0) AS orphan_cash,
        COALESCE(c."deferred_cash", 0) AS deferred_cash,
        COALESCE(r."cod_receivable", 0) AS cod_receivable,
        COALESCE(r."unpaid_online", 0) AS unpaid_online,
        COALESCE(dr."accrual_revenue", 0) AS accrual_revenue,
        COALESCE(c."online_paid_orders", 0) AS online_paid_orders,
        COALESCE(c."cod_collected_orders", 0) AS cod_collected_orders,
        COALESCE(c."orphan_cash_orders", 0) AS orphan_cash_orders,
        COALESCE(c."deferred_cash_orders", 0) AS deferred_cash_orders,
        COALESCE(r."cod_receivable_orders", 0) AS cod_receivable_orders,
        COALESCE(r."unpaid_online_orders", 0) AS unpaid_online_orders,
        COALESCE(dr."delivered_orders", 0) AS delivered_orders
      FROM currency_totals ct
      LEFT JOIN cash_totals c ON c."currency" = ct."currency"
      LEFT JOIN receivables r ON r."currency" = ct."currency"
      LEFT JOIN delivered_revenue dr ON dr."currency" = ct."currency"
      ORDER BY ct."currency"
    `);
  }

  /**
   * The order-level CTEs shared by every revenue query.
   *
   * Each source table is reduced to one row per order before it is joined:
   * payments, COD collections, promotions and delivery assignments. The line
   * allocation is a separate branch joined only by `order_id`, so an order with
   * five lines still contributes one order fact and one set of line totals.
   */
  private orderFactCtes(): Prisma.Sql {
    return Prisma.sql`
      latest_delivered_assignment AS (
        SELECT DISTINCT ON (da."order_id")
          da."order_id",
          da."id" AS assignment_id,
          da."delivery_staff_id",
          da."delivered_at",
          da."assigned_at"
        FROM "delivery_assignments" da
        WHERE da."status" = 'DELIVERED'
        ORDER BY da."order_id", da."assigned_at" DESC, da."id" DESC
      ),
      cod_collection_totals AS (
        SELECT
          cc."order_id",
          MAX(cc."amount") AS collected_amount,
          MIN(cc."collected_at") AS collected_at,
          MAX(cc."currency") AS currency
        FROM "cod_collections" cc
        GROUP BY cc."order_id"
      ),
      payment_totals AS (
        SELECT
          p."order_id",
          MAX(p."amount") FILTER (
            WHERE p."status" = 'PAID' AND cct."order_id" IS NULL
          ) AS online_paid_amount,
          MIN(p."paid_at") FILTER (
            WHERE p."status" = 'PAID' AND cct."order_id" IS NULL
          ) AS online_paid_at,
          MAX(p."currency") FILTER (
            WHERE p."status" = 'PAID' AND cct."order_id" IS NULL
          ) AS online_paid_currency,
          MAX(p."amount") FILTER (WHERE p."status" = 'PAID') AS any_paid_amount,
          MIN(p."paid_at") FILTER (WHERE p."status" = 'PAID') AS any_paid_at,
          COUNT(*) FILTER (WHERE p."status" = 'PAID') AS paid_attempt_count
        FROM "payments" p
        LEFT JOIN cod_collection_totals cct ON cct."order_id" = p."order_id"
        GROUP BY p."order_id"
      ),
      promotion_totals AS (
        SELECT
          pu."order_id",
          SUM(pu."discount_amount") FILTER (
            WHERE pu."discount_type" <> ${FREE_SHIPPING_DISCOUNT_TYPE}
          ) AS promo_product_discount,
          SUM(pu."discount_amount") FILTER (
            WHERE pu."discount_type" = ${FREE_SHIPPING_DISCOUNT_TYPE}
          ) AS promo_shipping_discount,
          SUM(pu."discount_amount") AS promo_total_discount,
          COUNT(*) AS usage_count
        FROM "promotion_usages" pu
        GROUP BY pu."order_id"
      ),
      order_facts AS (
        SELECT
          o."id" AS order_id,
          o."order_number",
          o."status",
          o."payment_method",
          o."currency",
          o."subtotal",
          o."shipping_fee",
          o."discount_amount",
          o."total_amount",
          o."created_at",
          lda."delivered_at",
          cct."collected_amount" AS cod_collected_amount,
          cct."collected_at" AS cod_collected_at,
          cct."currency" AS cod_collection_currency,
          pt."online_paid_amount",
          pt."online_paid_at",
          pt."online_paid_currency",
          pt."paid_attempt_count",
          COALESCE(pr."promo_product_discount", 0) AS promo_product_discount,
          COALESCE(pr."promo_shipping_discount", 0) AS promo_shipping_discount,
          COALESCE(pr."promo_total_discount", 0) AS promo_total_discount,
          COALESCE(pr."usage_count", 0) AS promotion_usage_count,
          LEAST(
            COALESCE(pr."promo_shipping_discount", 0),
            o."discount_amount"
          ) AS shipping_discount,
          o."discount_amount" - LEAST(
            COALESCE(pr."promo_shipping_discount", 0),
            o."discount_amount"
          ) AS product_discount,
          o."shipping_fee" - LEAST(
            COALESCE(pr."promo_shipping_discount", 0),
            o."discount_amount"
          ) AS shipping_revenue,
          o."subtotal" - (
            o."discount_amount" - LEAST(
              COALESCE(pr."promo_shipping_discount", 0),
              o."discount_amount"
            )
          ) AS net_product_revenue,
          (
            o."discount_amount" <> COALESCE(pr."promo_total_discount", 0)
          ) AS discount_mismatch,
          (pt."online_paid_amount" IS NOT NULL) AS online_paid,
          (cct."order_id" IS NOT NULL) AS cod_collected,
          (
            o."payment_method" = 'COD' OR cct."order_id" IS NOT NULL
          ) AS is_cod_order,
          (
            o."status" <> 'CANCELLED'
            AND (
              (
                o."payment_method" IS DISTINCT FROM 'COD'
                AND pt."online_paid_amount" IS NOT NULL
              )
              OR (
                o."payment_method" = 'COD'
                AND cct."order_id" IS NOT NULL
              )
            )
          ) AS booked_sale,
          (
            o."status" = 'DELIVERED' AND lda."delivered_at" IS NOT NULL
          ) AS delivered_sale,
          COALESCE(
            cct."collected_at",
            pt."online_paid_at",
            o."created_at"
          ) AS booked_at
        FROM "orders" o
        LEFT JOIN latest_delivered_assignment lda ON lda."order_id" = o."id"
        LEFT JOIN cod_collection_totals cct ON cct."order_id" = o."id"
        LEFT JOIN payment_totals pt ON pt."order_id" = o."id"
        LEFT JOIN promotion_totals pr ON pr."order_id" = o."id"
      )
    `;
  }

  /**
   * The revenue CTEs: the shared order facts, the eligible order set for the
   * chosen basis, and the deterministic line-level discount allocation.
   */
  private revenueCtes(filters: ResolvedFinanceRange): Prisma.Sql {
    const eventAt =
      filters.basis === 'delivered'
        ? Prisma.sql`of."delivered_at"`
        : Prisma.sql`of."booked_at"`;
    const basisPredicate =
      filters.basis === 'delivered'
        ? Prisma.sql`of."delivered_sale"
            AND of."delivered_at" >= ${filters.fromUtc}
            AND of."delivered_at" < ${filters.toExclusiveUtc}`
        : Prisma.sql`of."booked_sale"
            AND of."booked_at" >= ${filters.fromUtc}
            AND of."booked_at" < ${filters.toExclusiveUtc}`;
    const currencyFilter = filters.currency
      ? Prisma.sql`AND of."currency" = ${filters.currency}`
      : Prisma.empty;

    return Prisma.sql`
      ${this.orderFactCtes()},
      eligible_orders AS (
        SELECT of.*, ${eventAt} AS event_at
        FROM order_facts of
        WHERE ${basisPredicate} ${currencyFilter}
      ),
      line_base AS (
        SELECT
          oi."id" AS line_id,
          oi."order_id",
          oi."variant_id",
          oi."product_name" AS product_name_snapshot,
          oi."sku" AS sku_snapshot,
          oi."quantity",
          oi."line_total",
          oi."unit_cost_snapshot",
          oi."cost_currency",
          eo."currency" AS order_currency,
          eo."product_discount",
          ROW_NUMBER() OVER (
            PARTITION BY oi."order_id"
            ORDER BY oi."line_total" DESC, oi."id" ASC
          ) AS line_rank,
          SUM(oi."line_total") OVER (
            PARTITION BY oi."order_id"
          ) AS order_line_total
        FROM "order_items" oi
        JOIN eligible_orders eo ON eo."order_id" = oi."order_id"
      ),
      line_alloc_raw AS (
        SELECT
          lb.*,
          CASE
            WHEN lb."order_line_total" = 0 THEN 0
            ELSE FLOOR(
              (lb."product_discount" * lb."line_total" / lb."order_line_total")
              * 100
            ) / 100
          END AS base_allocated_discount
        FROM line_base lb
      ),
      line_alloc AS (
        SELECT
          lar.*,
          lar."base_allocated_discount" + CASE
            WHEN lar."line_rank" = 1 THEN
              lar."product_discount" - SUM(
                lar."base_allocated_discount"
              ) OVER (PARTITION BY lar."order_id")
            ELSE 0
          END AS allocated_discount,
          (
            lar."unit_cost_snapshot" IS NOT NULL
            AND lar."cost_currency" IS NOT NULL
            AND UPPER(TRIM(lar."cost_currency"))
              = UPPER(TRIM(lar."order_currency"))
          ) AS is_cost_comparable
        FROM line_alloc_raw lar
      ),
      line_finance AS (
        SELECT
          la.*,
          la."line_total" - la."allocated_discount" AS net_line_revenue,
          CASE
            WHEN la."is_cost_comparable"
            THEN la."quantity" * la."unit_cost_snapshot"
            ELSE NULL
          END AS line_cogs,
          CASE
            WHEN la."is_cost_comparable"
            THEN la."line_total" - la."allocated_discount"
            ELSE 0
          END AS costed_net_revenue,
          CASE
            WHEN la."is_cost_comparable" THEN la."line_total"
            ELSE 0
          END AS costed_line_total
        FROM line_alloc la
      ),
      line_totals AS (
        SELECT
          lf."order_id",
          SUM(lf."line_total") AS total_line_total,
          SUM(lf."allocated_discount") AS total_product_discount,
          SUM(lf."costed_line_total") AS costed_line_total,
          SUM(lf."costed_net_revenue") AS costed_net_revenue,
          SUM(lf."line_cogs") AS cogs
        FROM line_finance lf
        GROUP BY lf."order_id"
      )
    `;
  }

  private productTotalsCtes(filters: ResolvedFinanceRange): Prisma.Sql {
    return Prisma.sql`
      ${this.revenueCtes(filters)},
      product_totals AS (
        SELECT
          p."id" AS product_id,
          p."name" AS product_name,
          pv."id" AS variant_id,
          pv."sku" AS variant_sku,
          lf."order_currency" AS currency,
          COUNT(DISTINCT lf."order_id") AS order_count,
          SUM(lf."quantity") AS units_sold,
          SUM(lf."line_total") AS gross_revenue,
          SUM(lf."allocated_discount") AS product_discounts,
          SUM(lf."net_line_revenue") AS net_revenue,
          SUM(lf."costed_line_total") AS costed_line_total,
          SUM(lf."costed_net_revenue") AS costed_net_revenue,
          SUM(lf."line_cogs") AS cogs
        FROM line_finance lf
        JOIN "product_variants" pv ON pv."id" = lf."variant_id"
        JOIN "products" p ON p."id" = pv."product_id"
        GROUP BY
          p."id", p."name", pv."id", pv."sku", lf."order_currency"
      )
    `;
  }

  private productSortExpression(sortBy: FinanceProductSortBy): Prisma.Sql {
    switch (sortBy) {
      case 'profit':
        return Prisma.sql`CASE WHEN cogs IS NULL THEN NULL ELSE costed_net_revenue - cogs END`;
      case 'units':
        return Prisma.sql`units_sold`;
      case 'margin':
        return Prisma.sql`CASE WHEN cogs IS NULL OR costed_net_revenue = 0 THEN NULL ELSE (costed_net_revenue - cogs) / costed_net_revenue END`;
      case 'productName':
        return Prisma.sql`product_name`;
      case 'revenue':
      default:
        return Prisma.sql`net_revenue`;
    }
  }

  private rankingMetricExpression(metric: FinanceRankingMetric): Prisma.Sql {
    switch (metric) {
      case 'profit':
        return Prisma.sql`CASE WHEN cogs IS NULL THEN NULL ELSE costed_net_revenue - cogs END`;
      case 'units':
        return Prisma.sql`units_sold`;
      case 'revenue':
      default:
        return Prisma.sql`net_revenue`;
    }
  }
}
