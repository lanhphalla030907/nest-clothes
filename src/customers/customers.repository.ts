import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { Role } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PAYMENT_STATUS } from '../payments/constants/payment-status.constants.js';
import { ORDER_STATUS } from '../orders/constants/order-status.constants.js';
import { ACTIVE_USER_STATUS } from '../common/constants/user-status.constants.js';
import type {
  CustomerListSortBy,
  CustomerListSortOrder,
  CustomerOrderActivity,
} from './customers.constants.js';

type Count = bigint | number;

/**
 * One currency's spend for a customer, as aggregated by PostgreSQL and read
 * back from the `jsonb` the page query builds.
 *
 * `amount` is the database's own `NUMERIC` text output — never a JavaScript
 * number — so the service can serialise it with the exact two-decimal string
 * convention without a floating-point intermediate.
 */
export interface CustomerCurrencySpend {
  currency: string;
  amount: string;
  orderCount: number;
}

/**
 * One customer row of the administrative listing or detail view.
 *
 * Derived from the queries below rather than hand-written, so the read shape
 * and the type describing it cannot drift apart. `total_spent_by_currency`
 * never combines currencies: an entry exists per currency the customer has
 * spendable orders in, and a customer with no spendable orders has an empty
 * array rather than a zero.
 */
export interface AdminCustomerRow {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
  email_verified_at: Date | null;
  last_login_at: Date | null;
  /** Every order, in any status, including `CANCELLED`. */
  total_orders: number;
  /** Orders in `CANCELLED`, a subset of `total_orders`. */
  cancelled_orders: number;
  /** Orders that count toward spending; see {@link CustomersRepository}. */
  spending_orders: number;
  last_order_at: Date | null;
  total_spent_by_currency: CustomerCurrencySpend[];
}

/** The raw count answers before the service echoes them with the window. */
export interface CustomerStatsCounts {
  totalCustomers: number;
  activeCustomers: number;
  newCustomers: number;
  customersWithOrders: number;
}

/** Filters the service has already validated and normalised. */
export interface AdminCustomerListFilters {
  page: number;
  limit: number;
  search?: string;
  status?: string;
  registeredFrom?: Date;
  registeredTo?: Date;
  orderActivity?: CustomerOrderActivity;
  sortBy: CustomerListSortBy;
  sortOrder: CustomerListSortOrder;
}

/**
 * The safe projection for a customer's recent orders.
 *
 * `payments` reads at most one verified `PAID` attempt and `codCollections` at
 * most one cash collection (the unique `order_id` makes "at most one" a
 * constraint, `take` makes it one row in the result), so together they answer
 * "did money move for this order?" without loading payment artifacts. A
 * payment's `qrPayload` and a collection's `receiptProof` are deliberately
 * absent: they are provider and Cloudinary artifacts, not facts an operator
 * needs to recognise an order.
 */
const RECENT_ORDERS_SELECT = {
  id: true,
  orderNumber: true,
  status: true,
  paymentMethod: true,
  totalAmount: true,
  currency: true,
  createdAt: true,
  items: {
    select: { quantity: true },
  },
  payments: {
    where: { status: PAYMENT_STATUS.PAID },
    take: 1,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true },
  },
  codCollections: {
    take: 1,
    orderBy: [{ collectedAt: 'desc' }, { id: 'desc' }],
    select: { id: true },
  },
} satisfies Prisma.OrderSelect;

export type CustomerRecentOrderRow = Prisma.OrderGetPayload<{
  select: typeof RECENT_ORDERS_SELECT;
}>;

/**
 * The safe address-book projection.
 *
 * Addresses hold no credentials, but the projection is still explicit so a
 * future column on `addresses` cannot reach an administrative response by
 * accident. Ordering mirrors the customer's own address book: default first,
 * then oldest to newest, `id` as the deterministic tiebreak.
 */
const CUSTOMER_ADDRESSES_SELECT = {
  id: true,
  label: true,
  recipientName: true,
  phone: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  stateProvince: true,
  administrativeLocationPcode: true,
  postalCode: true,
  countryCode: true,
  isDefault: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.AddressSelect;

export type CustomerAddressRow = Prisma.AddressGetPayload<{
  select: typeof CUSTOMER_ADDRESSES_SELECT;
}>;

/**
 * The only place in the customers feature that talks to the database.
 *
 * ## Read-only
 *
 * Every method here is a read. The feature has no customer edit or delete
 * operations by design: nothing in this repository can write a `users` row.
 *
 * ## Who counts as a customer
 *
 * Every query in this repository is restricted to `role = 'CUSTOMER'`.
 * `ADMIN` and `DELIVERY_STAFF` accounts share the `users` table, and an
 * administrative customer listing must never expose them — their internal
 * accounts are managed elsewhere and are not customer records.
 *
 * ## What counts as spending
 *
 * Spending mirrors the finance feature's `booked_sale` rule, so the two
 * features can never disagree about what a customer paid:
 *
 * - a `CANCELLED` order never counts, in any currency, ever;
 * - a non-COD order counts only when some payment attempt reached `PAID`
 *   (an attempt that a COD collection claims does not count as online payment,
 *   exactly as in finance's `payment_totals`);
 * - a COD order counts only when a `cod_collections` row exists — cash the
 *   courier confirmed, not cash that was merely expected;
 * - the amount is `orders.total_amount` per order, never a sum of payment
 *   attempts, so a retried or duplicated attempt cannot multiply spending.
 *
 * Spendable totals are grouped **per currency** and never combined. The
 * application has no exchange rate, so a customer who spent 100 USD and 100 KHR
 * is reported as exactly those two figures, and sorting by spend ranks by the
 * largest single-currency total rather than an invented cross-currency sum.
 *
 * ## Why raw SQL
 *
 * The listing sorts by aggregates of related tables (`totalOrders`,
 * `totalSpent`), which Prisma's `orderBy` cannot express. The aggregation is
 * therefore built from CTEs that reduce `payments`, `cod_collections` and
 * `orders` to one row per customer *before* the page query joins them, so no
 * join can fan out and a second payment attempt cannot double-count an order.
 * The page and the count are issued in one transaction and share the same
 * filter fragments, so `total` always describes the same result set the page
 * was drawn from.
 */
@Injectable()
export class CustomersRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns one page of `CUSTOMER` users with their order counts, per-currency
   * spend and the total matching the same filters.
   */
  async findAdminPage(
    filters: AdminCustomerListFilters,
  ): Promise<{ items: AdminCustomerRow[]; total: number }> {
    const ctes = this.customerAggregateCtes();
    const where = this.buildCustomerWhere(filters);
    const sortExpression = this.customerSortExpression(filters.sortBy);
    const direction = Prisma.raw(
      filters.sortOrder === 'asc' ? 'ASC' : 'DESC',
    );
    const offset = (filters.page - 1) * filters.limit;
    // Only the `totalSpent` sort reads `customer_max_spend`, so only that sort
    // joins it; the other orderings leave the CTE unreferenced, and
    // PostgreSQL does not evaluate a CTE the query never uses.
    const maxSpendJoin =
      filters.sortBy === 'totalSpent'
        ? Prisma.sql`LEFT JOIN customer_max_spend cms ON cms."user_id" = u."id"`
        : Prisma.empty;

    const [rows, countRows] = await this.prisma.$transaction([
      this.prisma.$queryRaw<RawCustomerRow[]>(Prisma.sql`
        WITH ${ctes}
        SELECT
          u."id",
          u."first_name",
          u."last_name",
          u."email",
          u."phone",
          u."status",
          u."created_at",
          u."updated_at",
          u."email_verified_at",
          u."last_login_at",
          COALESCE(ct."total_orders", 0)::int AS total_orders,
          COALESCE(ct."cancelled_orders", 0)::int AS cancelled_orders,
          COALESCE(ct."spending_orders", 0)::int AS spending_orders,
          ct."last_order_at",
          COALESCE(csj."spend_by_currency", '[]'::jsonb) AS total_spent_by_currency
        FROM "users" u
        LEFT JOIN customer_totals ct ON ct."user_id" = u."id"
        LEFT JOIN customer_spend_json csj ON csj."user_id" = u."id"
        ${maxSpendJoin}
        WHERE ${where}
        ORDER BY
          ${sortExpression} ${direction},
          u."id" ASC
        LIMIT ${filters.limit} OFFSET ${offset}
      `),
      this.prisma.$queryRaw<Array<{ total: Count }>>(Prisma.sql`
        SELECT COUNT(*) AS total
        FROM "users" u
        WHERE ${where}
      `),
    ]);

    return {
      items: rows.map((row) => normalizeCustomerRow(row)),
      total: Number(countRows[0]?.total ?? 0),
    };
  }

  /**
   * Returns the `CUSTOMER` user with `id`, with the same aggregate shape as the
   * listing, or `null` when no such customer exists.
   *
   * The `role = 'CUSTOMER'` predicate is in the query itself, so an `ADMIN` or
   * `DELIVERY_STAFF` id returns `null` — exactly like an absent id — and the
   * service turns both into the same 404. An internal account is not a
   * customer record, and the response must not distinguish the two cases.
   */
  async findAdminCustomerById(
    id: string,
  ): Promise<AdminCustomerRow | null> {
    const rows = await this.prisma.$queryRaw<RawCustomerRow[]>(Prisma.sql`
      WITH ${this.customerAggregateCtes()}
      SELECT
        u."id",
        u."first_name",
        u."last_name",
        u."email",
        u."phone",
        u."status",
        u."created_at",
        u."updated_at",
        u."email_verified_at",
        u."last_login_at",
        COALESCE(ct."total_orders", 0)::int AS total_orders,
        COALESCE(ct."cancelled_orders", 0)::int AS cancelled_orders,
        COALESCE(ct."spending_orders", 0)::int AS spending_orders,
        ct."last_order_at",
        COALESCE(csj."spend_by_currency", '[]'::jsonb) AS total_spent_by_currency
      FROM "users" u
      LEFT JOIN customer_totals ct ON ct."user_id" = u."id"
      LEFT JOIN customer_spend_json csj ON csj."user_id" = u."id"
      WHERE u."id" = ${id}::uuid AND u."role" = 'CUSTOMER'
    `);

    const row = rows[0];
    return row === undefined ? null : normalizeCustomerRow(row);
  }

  /**
   * Returns one customer's most recent orders, newest first, `take` of them.
   *
   * Every status is included — a cancelled order is still a fact about the
   * relationship — and the lines are read only for their quantities, because
   * a recent-order row reports an item count rather than a receipt.
   */
  findRecentOrders(
    userId: string,
    take: number,
  ): Promise<CustomerRecentOrderRow[]> {
    return this.prisma.order.findMany({
      where: { userId },
      select: RECENT_ORDERS_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
    });
  }

  /**
   * Returns one customer's address book, default first.
   *
   * An empty array is a valid answer: a customer who never saved an address
   * has simply ordered with one-off shipping details.
   */
  findAddresses(userId: string): Promise<CustomerAddressRow[]> {
    return this.prisma.address.findMany({
      where: { userId },
      select: CUSTOMER_ADDRESSES_SELECT,
      orderBy: [
        { isDefault: 'desc' },
        { createdAt: 'asc' },
        { id: 'asc' },
      ],
    });
  }

  /**
   * The four summary counters, in one transaction so they describe one
   * consistent moment rather than four adjacent ones.
   *
   * - `totalCustomers`: every `CUSTOMER` account.
   * - `activeCustomers`: `CUSTOMER` accounts whose `status` is `ACTIVE`, the
   *   only value this application writes.
   * - `newCustomers`: `CUSTOMER` accounts created within
   *   {@link NEW_CUSTOMER_WINDOW_DAYS} of the cutoff the service passes in.
   * - `customersWithOrders`: `CUSTOMER` accounts with at least one order in
   *   **any** status, including `CANCELLED` — the question is whether a
   *   relationship exists, not whether money moved.
   */
  async getStats(
    newCustomersSince: Date,
  ): Promise<CustomerStatsCounts> {
    const [totalCustomers, activeCustomers, newCustomers, customersWithOrders] =
      await this.prisma.$transaction([
        this.prisma.user.count({ where: { role: Role.CUSTOMER } }),
        this.prisma.user.count({
          where: { role: Role.CUSTOMER, status: ACTIVE_USER_STATUS },
        }),
        this.prisma.user.count({
          where: {
            role: Role.CUSTOMER,
            createdAt: { gte: newCustomersSince },
          },
        }),
        this.prisma.user.count({
          where: { role: Role.CUSTOMER, orders: { some: {} } },
        }),
      ]);

    return {
      totalCustomers,
      activeCustomers,
      newCustomers,
      customersWithOrders,
    };
  }

  /**
   * The customer aggregation CTEs shared by the page and detail queries.
   *
   * Each source table is reduced to one row per order — or, after the grouped
   * CTEs, one row per customer — before anything is joined to `users`, so no
   * join can fan out and a second payment attempt cannot multiply spending.
   * The listing's count query needs none of them (the "has ordered?" filter is
   * an `EXISTS` on `orders`), which is why it runs without a `WITH` at all.
   */
  private customerAggregateCtes(): Prisma.Sql {
    return Prisma.sql`
      paid_orders AS (
        SELECT DISTINCT p."order_id"
        FROM "payments" p
        WHERE p."status" = ${PAYMENT_STATUS.PAID}
          AND NOT EXISTS (
            SELECT 1
            FROM "cod_collections" cc
            WHERE cc."payment_id" = p."id"
          )
      ),
      collected_orders AS (
        SELECT DISTINCT cc."order_id"
        FROM "cod_collections" cc
      ),
      order_facts AS (
        SELECT
          o."id" AS order_id,
          o."user_id",
          o."status",
          o."currency",
          o."total_amount",
          o."created_at",
          (
            o."status" <> ${ORDER_STATUS.CANCELLED}
            AND (
              (
                o."payment_method" IS DISTINCT FROM 'COD'
                AND po."order_id" IS NOT NULL
              )
              OR (
                o."payment_method" = 'COD'
                AND co."order_id" IS NOT NULL
              )
            )
          ) AS spendable
        FROM "orders" o
        LEFT JOIN paid_orders po ON po."order_id" = o."id"
        LEFT JOIN collected_orders co ON co."order_id" = o."id"
      ),
      customer_totals AS (
        SELECT
          of."user_id",
          COUNT(*) AS total_orders,
          COUNT(*) FILTER (
            WHERE of."status" = ${ORDER_STATUS.CANCELLED}
          ) AS cancelled_orders,
          COUNT(*) FILTER (WHERE of."spendable") AS spending_orders,
          MAX(of."created_at") AS last_order_at
        FROM order_facts of
        GROUP BY of."user_id"
      ),
      customer_spend AS (
        SELECT
          of."user_id",
          of."currency",
          SUM(of."total_amount") AS spent,
          COUNT(*) AS order_count
        FROM order_facts of
        WHERE of."spendable"
        GROUP BY of."user_id", of."currency"
      ),
      customer_max_spend AS (
        SELECT
          cs."user_id",
          MAX(cs."spent") AS max_spent
        FROM customer_spend cs
        GROUP BY cs."user_id"
      ),
      customer_spend_json AS (
        SELECT
          cs."user_id",
          jsonb_agg(
            jsonb_build_object(
              'currency', cs."currency",
              'amount', cs."spent"::text,
              'orderCount', cs."order_count"::int
            ) ORDER BY cs."currency" ASC
          ) AS spend_by_currency
        FROM customer_spend cs
        GROUP BY cs."user_id"
      )
    `;
  }

  /**
   * Builds the shared `WHERE` fragment for the page and the count.
   *
   * The fragments are `Prisma.Sql` values embedded as bound parameters, so a
   * search term is never string-concatenated into SQL, and `u."role" =
   * 'CUSTOMER'` is always the first predicate: an administrator or delivery
   * account can never match a customer listing filter, whatever else the
   * request says.
   */
  private buildCustomerWhere(filters: AdminCustomerListFilters): Prisma.Sql {
    const conditions: Prisma.Sql[] = [
      Prisma.sql`u."role" = 'CUSTOMER'`,
    ];

    if (filters.status !== undefined) {
      conditions.push(Prisma.sql`u."status" = ${filters.status}`);
    }

    if (filters.registeredFrom !== undefined) {
      conditions.push(Prisma.sql`u."created_at" >= ${filters.registeredFrom}`);
    }

    if (filters.registeredTo !== undefined) {
      conditions.push(Prisma.sql`u."created_at" <= ${filters.registeredTo}`);
    }

    if (filters.search !== undefined) {
      const pattern = `%${escapeLikePattern(filters.search)}%`;
      conditions.push(Prisma.sql`(
        u."first_name" ILIKE ${pattern}
        OR u."last_name" ILIKE ${pattern}
        OR u."email" ILIKE ${pattern}
        OR u."phone" ILIKE ${pattern}
      )`);
    }

    if (filters.orderActivity !== undefined) {
      const exists = Prisma.sql`EXISTS (
        SELECT 1
        FROM "orders" eo
        WHERE eo."user_id" = u."id"
      )`;
      conditions.push(
        filters.orderActivity === 'WITH_ORDERS'
          ? exists
          : Prisma.sql`NOT ${exists}`,
      );
    }

    return Prisma.join(conditions, ' AND ');
  }

  /**
   * The sort expression for the listing.
   *
   * Only the four documented columns are reachable: the DTO validated the value
   * before the repository ran, and the default branch is the same expression
   * as `createdAt`, so an unknown value can never reach a column name.
   */
  private customerSortExpression(sortBy: CustomerListSortBy): Prisma.Sql {
    switch (sortBy) {
      case 'name':
        // A row constructor, so the household surname leads and the given
        // name breaks ties inside the same expression.
        return Prisma.sql`(u."last_name", u."first_name")`;
      case 'totalOrders':
        return Prisma.sql`COALESCE(ct."total_orders", 0)`;
      case 'totalSpent':
        // The customer's largest single-currency total, never a sum across
        // currencies the application has no exchange rate for.
        return Prisma.sql`COALESCE(cms."max_spent", 0)`;
      case 'createdAt':
      default:
        return Prisma.sql`u."created_at"`;
    }
  }
}

/**
 * The shape PostgreSQL returns before the `jsonb` column is normalised.
 *
 * `total_spent_by_currency` is `unknown` because the driver may deliver `jsonb`
 * as a parsed value or as its text form; {@link normalizeCustomerRow} turns
 * either into {@link CustomerCurrencySpend}[].
 */
interface RawCustomerRow {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
  email_verified_at: Date | null;
  last_login_at: Date | null;
  total_orders: Count;
  cancelled_orders: Count;
  spending_orders: Count;
  last_order_at: Date | null;
  total_spent_by_currency: unknown;
}

/** Coerces one raw page/detail row to its normalised shape. */
function normalizeCustomerRow(row: RawCustomerRow): AdminCustomerRow {
  return {
    id: row.id,
    first_name: row.first_name,
    last_name: row.last_name,
    email: row.email,
    phone: row.phone,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    email_verified_at: row.email_verified_at,
    last_login_at: row.last_login_at,
    total_orders: Number(row.total_orders),
    cancelled_orders: Number(row.cancelled_orders),
    spending_orders: Number(row.spending_orders),
    last_order_at: row.last_order_at,
    total_spent_by_currency: normalizeSpendByCurrency(
      row.total_spent_by_currency,
    ),
  };
}

/**
 * Normalises the `jsonb` spend column to typed entries.
 *
 * The SQL casts every money value to text and every count to `int` *before* it
 * becomes JSON, so the amounts survive as exact strings and the counts as
 * safe integers. This helper only has to accept the parsed value or its text
 * form, depending on how the driver delivers `jsonb`, and to leave an absent
 * value as an empty array: "no spendable orders" is a fact, not a zero.
 */
function normalizeSpendByCurrency(value: unknown): CustomerCurrencySpend[] {
  const parsed =
    typeof value === 'string' ? (JSON.parse(value) as unknown) : value;

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.map((entry) => {
    const record = entry as Record<string, unknown>;
    return {
      currency: String(record.currency),
      amount: String(record.amount),
      orderCount: Number(record.orderCount),
    };
  });
}

/**
 * Escapes the characters PostgreSQL's `LIKE`/`ILIKE` treat as wildcards.
 *
 * `%`, `_` and `\` are made literal again, so a search for `%` does not match
 * every customer and `_` does not match any single character. PostgreSQL uses
 * backslash as the default `LIKE` escape character, so doubling a backslash
 * and prefixing `%`/`_` restores each character's meaning.
 *
 * Duplicated locally rather than imported from the orders feature, because it
 * is an internal helper there; the customers listing must not reach into the
 * orders module's private utilities. The escaped value is still passed to
 * Prisma as a bound parameter.
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}
