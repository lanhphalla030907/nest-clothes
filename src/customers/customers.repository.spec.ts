import { Test, TestingModule } from '@nestjs/testing';
import type { Mock } from 'vitest';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  CustomersRepository,
  type AdminCustomerRow,
} from './customers.repository.js';

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';

/**
 * Reconstructs the SQL text and ordered parameters a `Prisma.Sql` fragment
 * will send.
 *
 * `Prisma.sql` flattens nested fragments at construction, so `strings` and
 * `values` are already the final order; this only interleaves them with
 * numbered placeholders the way the query renderer does. Query *shape* is the
 * thing under test: whether the role predicate is present, whether only safe
 * columns are selected, whether a search term is a bound parameter rather than
 * concatenated SQL, and whether the page and the count share one WHERE.
 */
function flattenSql(sql: Prisma.Sql): { text: string; values: unknown[] } {
  let text = sql.strings[0] ?? '';
  sql.values.forEach((value, i) => {
    text += `$${i + 1}`;
    text += sql.strings[i + 1] ?? '';
  });
  return { text, values: sql.values };
}

/** A raw page/detail row as PostgreSQL would return it. */
function rawRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CUSTOMER_ID,
    first_name: 'Spend',
    last_name: 'Tester',
    email: 'spend@example.test',
    phone: '+15555550100',
    status: 'ACTIVE',
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-02T00:00:00.000Z'),
    email_verified_at: null,
    last_login_at: null,
    total_orders: 7,
    cancelled_orders: 1,
    spending_orders: 4,
    last_order_at: new Date('2026-02-01T00:00:00.000Z'),
    total_spent_by_currency: [
      { currency: 'USD', amount: '180.00', orderCount: 3 },
      { currency: 'KHR', amount: '400000.00', orderCount: 1 },
    ],
    ...overrides,
  };
}

/**
 * These assertions are about *query shape*, not results: the SQL each method
 * hands to Prisma is what decides whether an administrator or delivery staff
 * account can appear in a customer listing, whether a search term can inject
 * SQL, whether the page and the count can disagree, and whether the JSONB
 * spend column survives as exact strings. A behavioural mock of the service
 * cannot see any of that, so it is pinned here.
 */
describe('CustomersRepository', () => {
  let repository: CustomersRepository;
  let prisma: {
    $queryRaw: Mock;
    $transaction: Mock;
    order: { findMany: Mock };
    address: { findMany: Mock };
    user: { count: Mock };
  };

  beforeEach(async () => {
    prisma = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      $transaction: vi.fn(),
      order: { findMany: vi.fn().mockResolvedValue([]) },
      address: { findMany: vi.fn().mockResolvedValue([]) },
      user: { count: vi.fn().mockResolvedValue(0) },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CustomersRepository,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    repository = module.get(CustomersRepository);
    prisma.$transaction.mockImplementation(
      (input: ((tx: unknown) => Promise<unknown>) | Promise<unknown>[]) =>
        typeof input === 'function' ? input(prisma) : Promise.all(input),
    );
  });

  describe('findAdminPage', () => {
    beforeEach(() => {
      prisma.$queryRaw.mockResolvedValue([rawRow()]);
    });

    it('runs the page and the count in one transaction', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      const result = await repository.findAdminPage({
        page: 3,
        limit: 10,
        sortBy: 'createdAt',
        sortOrder: 'desc',
      });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.$transaction.mock.calls[0][0]).toHaveLength(2);
      expect(result.total).toBe(0);
      expect(result.items).toEqual([]);
    });

    it('restricts every query to the CUSTOMER role first', async () => {
      await repository.findAdminPage({
        page: 1,
        limit: 20,
        sortBy: 'createdAt',
        sortOrder: 'desc',
      });

      const page = flattenSql(prisma.$queryRaw.mock.calls[0][0] as Prisma.Sql);
      const count = flattenSql(prisma.$queryRaw.mock.calls[1][0] as Prisma.Sql);

      expect(page.text).toContain(`WHERE u."role" = 'CUSTOMER'`);
      expect(count.text).toContain(`WHERE u."role" = 'CUSTOMER'`);
    });

    it('selects identity columns but never a credential column', async () => {
      await repository.findAdminPage({
        page: 1,
        limit: 20,
        sortBy: 'createdAt',
        sortOrder: 'desc',
      });

      const page = flattenSql(prisma.$queryRaw.mock.calls[0][0] as Prisma.Sql);

      expect(page.text).toContain('u."email"');
      expect(page.text).toContain('u."phone"');
      expect(page.text).not.toContain('password_hash');
      expect(page.text).not.toContain('passwordHash');
    });

    it('binds page and limit instead of concatenating them', async () => {
      await repository.findAdminPage({
        page: 3,
        limit: 10,
        sortBy: 'createdAt',
        sortOrder: 'desc',
      });

      const page = flattenSql(prisma.$queryRaw.mock.calls[0][0] as Prisma.Sql);

      // The page query binds its three CTE parameters first, so LIMIT and
      // OFFSET are the last two placeholders, not the first two.
      expect(page.text).toContain('LIMIT $4 OFFSET $5');
      expect(page.values.slice(-2)).toEqual([10, 20]);
    });

    it('orders deterministically with the id as the tiebreak', async () => {
      await repository.findAdminPage({
        page: 1,
        limit: 20,
        sortBy: 'createdAt',
        sortOrder: 'asc',
      });

      const page = flattenSql(prisma.$queryRaw.mock.calls[0][0] as Prisma.Sql);

      expect(page.text).toContain(
        `ORDER BY\n          u."created_at" ASC,\n          u."id" ASC`,
      );
    });

    it('sorts names by surname then given name', async () => {
      await repository.findAdminPage({
        page: 1,
        limit: 20,
        sortBy: 'name',
        sortOrder: 'desc',
      });

      const page = flattenSql(prisma.$queryRaw.mock.calls[0][0] as Prisma.Sql);

      expect(page.text).toContain(`(u."last_name", u."first_name") DESC`);
    });

    it('sorts by total orders through the aggregate, not a user column', async () => {
      await repository.findAdminPage({
        page: 1,
        limit: 20,
        sortBy: 'totalOrders',
        sortOrder: 'desc',
      });

      const page = flattenSql(prisma.$queryRaw.mock.calls[0][0] as Prisma.Sql);

      expect(page.text).toContain(`COALESCE(ct."total_orders", 0) DESC`);
    });

    it('sorts by the largest single-currency spend and joins only what it needs', async () => {
      await repository.findAdminPage({
        page: 1,
        limit: 20,
        sortBy: 'totalSpent',
        sortOrder: 'desc',
      });

      const page = flattenSql(prisma.$queryRaw.mock.calls[0][0] as Prisma.Sql);

      expect(page.text).toContain(`COALESCE(cms."max_spent", 0) DESC`);
      expect(page.text).toContain(
        `LEFT JOIN customer_max_spend cms ON cms."user_id" = u."id"`,
      );
    });

    it('does not join the max-spend CTE for other sorts', async () => {
      await repository.findAdminPage({
        page: 1,
        limit: 20,
        sortBy: 'createdAt',
        sortOrder: 'desc',
      });

      const page = flattenSql(prisma.$queryRaw.mock.calls[0][0] as Prisma.Sql);

      expect(page.text).not.toContain('customer_max_spend cms');
    });

    it('binds status and both date bounds as parameters, oldest first in the text', async () => {
      const registeredFrom = new Date('2026-01-01T00:00:00.000Z');
      const registeredTo = new Date('2026-02-01T00:00:00.000Z');

      await repository.findAdminPage({
        page: 1,
        limit: 20,
        status: 'ACTIVE',
        registeredFrom,
        registeredTo,
        sortBy: 'createdAt',
        sortOrder: 'desc',
      });

      const page = flattenSql(prisma.$queryRaw.mock.calls[0][0] as Prisma.Sql);
      const count = flattenSql(prisma.$queryRaw.mock.calls[1][0] as Prisma.Sql);

      // The page query binds its three CTE parameters first
      // ($1 = PAID, $2/$3 = CANCELLED), so the filter parameters start at $4.
      expect(page.text).toContain(
        `u."status" = $4 AND u."created_at" >= $5 AND u."created_at" <= $6`,
      );
      expect(page.values.slice(3, 6)).toEqual([
        'ACTIVE',
        registeredFrom,
        registeredTo,
      ]);
      // The count has no CTEs, so the same predicates bind from $1 and the
      // count sees exactly the page's filters — it cannot describe a
      // different result set than the page.
      expect(count.text).toContain(
        `u."status" = $1 AND u."created_at" >= $2 AND u."created_at" <= $3`,
      );
      expect(count.values).toEqual(['ACTIVE', registeredFrom, registeredTo]);
    });

    it('searches names, email and phone as bound ILIKE parameters', async () => {
      await repository.findAdminPage({
        page: 1,
        limit: 20,
        search: 'a%da',
        sortBy: 'createdAt',
        sortOrder: 'desc',
      });

      const page = flattenSql(prisma.$queryRaw.mock.calls[0][0] as Prisma.Sql);
      const count = flattenSql(prisma.$queryRaw.mock.calls[1][0] as Prisma.Sql);

      // The page query binds its three CTE parameters first, so the four
      // ILIKE patterns start at $4; the count has no CTEs, so they start at $1.
      expect(page.text).toContain('u."first_name" ILIKE $4');
      expect(page.text).toContain('u."last_name" ILIKE $5');
      expect(page.text).toContain('u."email" ILIKE $6');
      expect(page.text).toContain('u."phone" ILIKE $7');
      // All four columns share the same wrapped, escaped pattern.
      expect(page.values[3]).toBe('%a\\%da%');
      expect(new Set(page.values.slice(3, 7)).size).toBe(1);
      expect(count.text).toContain('u."first_name" ILIKE $1');
      expect(count.text).toContain('u."phone" ILIKE $4');
      expect(new Set(count.values.slice(0, 4)).size).toBe(1);
    });

    it('filters WITH_ORDERS with an EXISTS over orders', async () => {
      await repository.findAdminPage({
        page: 1,
        limit: 20,
        orderActivity: 'WITH_ORDERS',
        sortBy: 'createdAt',
        sortOrder: 'desc',
      });

      const page = flattenSql(prisma.$queryRaw.mock.calls[0][0] as Prisma.Sql);

      // The `paid_orders` CTE has a NOT EXISTS of its own, so the assertion
      // targets the outer query — everything after `FROM "users" u`.
      const outerQuery = page.text.split('FROM "users" u')[1] ?? '';
      expect(outerQuery).toContain('EXISTS (');
      expect(outerQuery).not.toContain('NOT EXISTS');
    });

    it('filters WITHOUT_ORDERS with a negated EXISTS', async () => {
      await repository.findAdminPage({
        page: 1,
        limit: 20,
        orderActivity: 'WITHOUT_ORDERS',
        sortBy: 'createdAt',
        sortOrder: 'desc',
      });

      const page = flattenSql(prisma.$queryRaw.mock.calls[0][0] as Prisma.Sql);

      const outerQuery = page.text.split('FROM "users" u')[1] ?? '';
      expect(outerQuery).toContain('NOT EXISTS (');
    });

    it('keeps the spendable rule as finance books a sale: cancelled never counts, COD needs a collection, online needs a verified payment that no collection claims', async () => {
      await repository.findAdminPage({
        page: 1,
        limit: 20,
        sortBy: 'createdAt',
        sortOrder: 'desc',
      });

      const page = flattenSql(prisma.$queryRaw.mock.calls[0][0] as Prisma.Sql);

      // The CTEs bind their own constants before any filter: $1 = PAID,
      // $2/$3 = CANCELLED.
      expect(page.text).toContain(`WHERE p."status" = $1`);
      expect(page.values[0]).toBe('PAID');
      expect(page.text).toContain(`o."status" <> $2`);
      expect(page.values[1]).toBe('CANCELLED');
      expect(page.text).toContain(
        `o."payment_method" IS DISTINCT FROM 'COD'`,
      );
      expect(page.text).toContain(`o."payment_method" = 'COD'`);
      expect(page.text).toContain(
        `FROM "cod_collections" cc\n            WHERE cc."payment_id" = p."id"`,
      );
      // The spendable amount is the order's own total, never a payment sum.
      expect(page.text).toContain(`SUM(of."total_amount") AS spent`);
      expect(page.text).not.toContain('SUM(p."amount")');
    });

    it('spends per currency and never combines them', async () => {
      await repository.findAdminPage({
        page: 1,
        limit: 20,
        sortBy: 'createdAt',
        sortOrder: 'desc',
      });

      const page = flattenSql(prisma.$queryRaw.mock.calls[0][0] as Prisma.Sql);

      expect(page.text).toContain(
        `GROUP BY of."user_id", of."currency"`,
      );
      expect(page.text).toContain(`'amount', cs."spent"::text`);
      expect(page.text).toContain(`MAX(cs."spent") AS max_spent`);
    });

    it('normalises the page rows, including counts and the jsonb spend', async () => {
      prisma.$queryRaw.mockResolvedValue([
        rawRow({
          total_orders: 7n,
          cancelled_orders: 1n,
          spending_orders: 4n,
        }),
      ]);

      const result = await repository.findAdminPage({
        page: 1,
        limit: 20,
        sortBy: 'createdAt',
        sortOrder: 'desc',
      });

      expect(result.items[0]).toMatchObject({
        id: CUSTOMER_ID,
        first_name: 'Spend',
        total_orders: 7,
        cancelled_orders: 1,
        spending_orders: 4,
        total_spent_by_currency: [
          { currency: 'USD', amount: '180.00', orderCount: 3 },
          { currency: 'KHR', amount: '400000.00', orderCount: 1 },
        ],
      });
    });

    it('accepts the jsonb column as its text form too', async () => {
      prisma.$queryRaw.mockResolvedValue([
        rawRow({
          total_spent_by_currency: JSON.stringify([
            { currency: 'USD', amount: '180.00', orderCount: 3 },
          ]),
        }),
      ]);

      const result = await repository.findAdminPage({
        page: 1,
        limit: 20,
        sortBy: 'createdAt',
        sortOrder: 'desc',
      });

      expect(result.items[0].total_spent_by_currency).toEqual([
        { currency: 'USD', amount: '180.00', orderCount: 3 },
      ]);
    });

    it('reports an absent spend as an empty array, not zero', async () => {
      prisma.$queryRaw.mockResolvedValue([
        rawRow({ total_spent_by_currency: null }),
      ]);

      const result = await repository.findAdminPage({
        page: 1,
        limit: 20,
        sortBy: 'createdAt',
        sortOrder: 'desc',
      });

      expect(result.items[0].total_spent_by_currency).toEqual([]);
    });
  });

  describe('findAdminCustomerById', () => {
    it('queries by id and the CUSTOMER role, and returns null when absent', async () => {
      const result = await repository.findAdminCustomerById(ADMIN_ID);

      expect(result).toBeNull();
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      const detail = flattenSql(prisma.$queryRaw.mock.calls[0][0] as Prisma.Sql);
      expect(detail.text).toContain(`u."id" = $4::uuid`);
      expect(detail.values[3]).toBe(ADMIN_ID);
      expect(detail.text).toContain(`AND u."role" = 'CUSTOMER'`);
    });

    it('returns the normalised row when the customer exists', async () => {
      prisma.$queryRaw.mockResolvedValue([rawRow()]);

      const result = await repository.findAdminCustomerById(CUSTOMER_ID);

      expect(result).not.toBeNull();
      expect((result as AdminCustomerRow).total_orders).toBe(7);
      expect((result as AdminCustomerRow).total_spent_by_currency).toEqual([
        { currency: 'USD', amount: '180.00', orderCount: 3 },
        { currency: 'KHR', amount: '400000.00', orderCount: 1 },
      ]);
    });
  });

  describe('findRecentOrders', () => {
    it('reads a bounded, newest-first page of safe order columns', async () => {
      await repository.findRecentOrders(CUSTOMER_ID, 5);

      expect(prisma.order.findMany).toHaveBeenCalledWith({
        where: { userId: CUSTOMER_ID },
        select: expect.objectContaining({
          id: true,
          orderNumber: true,
          status: true,
          paymentMethod: true,
          totalAmount: true,
          currency: true,
        }),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 5,
      });
      const select = prisma.order.findMany.mock.calls[0][0]
        .select as Record<string, { select: Record<string, boolean> }>;
      // Payment evidence is read for existence only, never the QR artifacts.
      expect(select.payments.select).toEqual({ id: true });
      expect(select.codCollections.select).toEqual({ id: true });
      expect(select.payments.where).toEqual({ status: 'PAID' });
      expect(select.payments.take).toBe(1);
    });
  });

  describe('findAddresses', () => {
    it('reads the address book default-first', async () => {
      await repository.findAddresses(CUSTOMER_ID);

      expect(prisma.address.findMany).toHaveBeenCalledWith({
        where: { userId: CUSTOMER_ID },
        select: expect.objectContaining({
          label: true,
          recipientName: true,
          countryCode: true,
          isDefault: true,
        }),
        orderBy: [
          { isDefault: 'desc' },
          { createdAt: 'asc' },
          { id: 'asc' },
        ],
      });
    });
  });

  describe('getStats', () => {
    it('counts the four figures over CUSTOMER accounts only, in one transaction', async () => {
      const cutoff = new Date('2026-10-12T00:00:00.000Z');
      prisma.user.count
        .mockResolvedValueOnce(32)
        .mockResolvedValueOnce(30)
        .mockResolvedValueOnce(4)
        .mockResolvedValueOnce(9);

      const stats = await repository.getStats(cutoff);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.$transaction.mock.calls[0][0]).toHaveLength(4);
      expect(prisma.user.count).toHaveBeenNthCalledWith(1, {
        where: { role: 'CUSTOMER' },
      });
      expect(prisma.user.count).toHaveBeenNthCalledWith(2, {
        where: { role: 'CUSTOMER', status: 'ACTIVE' },
      });
      expect(prisma.user.count).toHaveBeenNthCalledWith(3, {
        where: { role: 'CUSTOMER', createdAt: { gte: cutoff } },
      });
      expect(prisma.user.count).toHaveBeenNthCalledWith(4, {
        where: { role: 'CUSTOMER', orders: { some: {} } },
      });
      expect(stats).toEqual({
        totalCustomers: 32,
        activeCustomers: 30,
        newCustomers: 4,
        customersWithOrders: 9,
      });
    });
  });
});
