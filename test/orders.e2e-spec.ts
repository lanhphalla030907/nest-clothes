import 'dotenv/config';
import {
  HttpStatus,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { Prisma } from '../src/generated/prisma/client.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { TEMPORARY_USER_ID_HEADER } from '../src/common/decorators/temporary-user-id.decorator.js';
import { OrderModule } from '../src/orders/order.module.js';
import { OrderNumberGenerator } from '../src/orders/order-number.generator.js';

/**
 * Order behaviour against a **real PostgreSQL** database.
 *
 * The unit specs pin the rules the service intends. This file proves the parts that
 * are the *database's* job, which no mock can demonstrate:
 *
 * - every `CHECK` constraint really does make a negative amount, a mis-summed total
 *   and a non-positive quantity unwritable — by any writer, including a direct
 *   `prisma` call that bypasses the service entirely;
 * - `UNIQUE (order_number)` really is what settles a concurrent collision;
 * - `ON DELETE RESTRICT` on `orders.user_id` and `order_items.variant_id` really
 *   does refuse the delete, and `ON DELETE CASCADE` from `orders` really does take
 *   the lines with it;
 * - a snapshot really is immune to later catalogue edits, which is the entire
 *   reason `order_items` stores names and prices instead of joining to them.
 *
 * Fixtures are written with `prisma` directly rather than through `OrderRepository`,
 * so a bug in the repository cannot hide by also being what built the data the
 * assertions run against. The service's own write path is covered by unit tests,
 * where its collaborators can be controlled precisely.
 *
 * It runs as part of `npm run test:e2e` and needs a reachable `DATABASE_URL`. Every
 * fixture is namespaced by a per-run token and removed in `afterAll` in foreign-key
 * order, so repeated runs never collide and never leave debris behind.
 */
describe('Orders (PostgreSQL)', () => {
  const run = randomUUID().slice(0, 8);
  /** Six uppercase characters, so seeded numbers match the documented shape. */
  const tag = run.slice(0, 6).toUpperCase();
  const email = (name: string) => `orders-${run}-${name}@example.test`;
  const slug = (name: string) => `orders-${run}-${name}`;

  let app: INestApplication;
  let prisma: PrismaService;
  let base: string;
  let categoryId: string;
  let productId: string;
  let variantId: string;
  /** The caller in most tests. Two orders, deliberately different statuses. */
  let userId: string;
  /** A different customer, holding one order used only to prove ownership. */
  let otherUserId: string;
  /** A customer who has never ordered anything. */
  let newcomerId: string;
  /** Oldest, `CONFIRMED`, two units, free shipping. */
  let olderOrderId: string;
  /** Newest, `SHIPPED`, one unit, paid shipping and a discount. */
  let newerOrderId: string;
  /** Belongs to `otherUserId`. */
  let otherOrderId: string;

  /** Monotonic suffix, so throwaway order numbers are unique within a run. */
  let sequence = 0;
  const nextOrderNumber = (letter: string) =>
    `PROBE-${run}-${letter}${(sequence += 1).toString(36).toUpperCase()}`;

  const headers = (id: string) => ({
    'Content-Type': 'application/json',
    [TEMPORARY_USER_ID_HEADER]: id,
  });

  const api = async (
    method: string,
    path: string,
    options: { user?: string | null; body?: unknown } = {},
  ) => {
    const requestHeaders =
      options.user === null
        ? { 'Content-Type': 'application/json' }
        : headers(options.user ?? userId);

    const res = await fetch(`${base}${path}`, {
      method,
      headers: requestHeaders,
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    });

    const text = await res.text();

    return {
      status: res.status,
      body: text.length === 0 ? undefined : JSON.parse(text),
    };
  };

  const getOrders = async (user: string | null = userId) =>
    (await api('GET', '/orders', { user })).body;

  const getOrder = async (id: string, user: string | null = userId) =>
    api('GET', `/orders/${id}`, { user });

  /** A valid order, for a test to break in one specific way. */
  const order = (orderNumber: string, overrides: Record<string, unknown> = {}) => ({
    userId,
    orderNumber,
    status: 'PENDING',
    subtotal: '10.00',
    shippingFee: '0.00',
    discountAmount: '0.00',
    totalAmount: '10.00',
    currency: 'USD',
    shippingRecipientName: 'Constraint Tester',
    shippingPhone: '+15555550103',
    shippingAddressLine1: '3 Check Lane',
    shippingCity: 'Cardiff',
    shippingCountryCode: 'GB',
    ...overrides,
  });

  /** A valid line, for a test to break in one specific way. */
  const line = (overrides: Record<string, unknown> = {}) => ({
    variantId,
    productName: 'Wool Peacoat',
    sku: slug('SKU-coat'),
    variantOptionsSnapshot: [],
    unitPrice: '10.00',
    quantity: 1,
    lineTotal: '10.00',
    ...overrides,
  });

  /** Asserts the named `CHECK` constraint refused the write. */
  const expectCheckViolation = async (
    promise: Promise<unknown>,
    constraint: string,
  ) => {
    await expect(promise).rejects.toThrow(constraint);
  };

  /**
   * Asserts an `order_items` `CHECK` refused the write, without pinning *which* one.
   *
   * Some violations overlap by necessity — a zero quantity makes `line_total` zero
   * too — and Postgres reports whichever constraint it evaluates first. Asserting a
   * specific name there would test Postgres' evaluation order rather than this
   * schema, so the shape of the guarantee is asserted instead: the write is refused,
   * and it is an item-level `CHECK` that refuses it.
   */
  const expectItemCheckViolation = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => null,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((error as { code: string }).code).toBe('P2039');
    expect((error as Error).message).toContain('order_items_');
  };

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        'DATABASE_URL is not set — the orders integration tests need a real PostgreSQL instance',
      );
    }

    const module: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule, OrderModule],
    }).compile();

    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.listen(0);
    base = await app.getUrl();
    prisma = app.get(PrismaService);

    const category = await prisma.category.create({
      data: { name: `Orders ${run}`, slug: slug('category') },
    });
    categoryId = category.id;

    const createUser = async (name: string) =>
      (
        await prisma.user.create({
          data: {
            firstName: 'Order',
            lastName: 'Tester',
            email: email(name),
            passwordHash: 'argon2-not-a-real-hash',
            status: 'ACTIVE',
          },
        })
      ).id;

    userId = await createUser('owner');
    otherUserId = await createUser('other');
    newcomerId = await createUser('newcomer');

    const product = await prisma.product.create({
      data: {
        categoryId,
        name: 'Wool Peacoat',
        slug: slug('product'),
        basePrice: '129.00',
        status: 'ACTIVE',
      },
    });
    productId = product.id;

    const variant = await prisma.productVariant.create({
      data: { productId, sku: slug('SKU-coat'), price: '129.00' },
    });
    variantId = variant.id;

    await prisma.variantOption.createMany({
      data: [
        { variantId, optionName: 'Color', optionValue: 'Navy' },
        { variantId, optionName: 'Size', optionValue: 'M' },
      ],
    });

    await prisma.inventory.create({ data: { variantId, quantity: 25 } });

    /**
     * Writes an order straight through `prisma`.
     *
     * `createdAt` is supplied rather than left to the default so the listing's
     * ordering is unambiguous and does not depend on how quickly the fixture loop
     * runs; `options` and the snapshot fields likewise, so the snapshot tests have
     * something real to protect.
     */
    const seedOrder = async (data: {
      userId: string;
      orderNumber: string;
      status: string;
      createdAt: Date;
      subtotal: string;
      shippingFee?: string;
      discountAmount?: string;
      quantity?: number;
      unitPrice?: string;
      lineTotal?: string;
    }) => {
      const unitPrice = data.unitPrice ?? '129.00';
      const quantity = data.quantity ?? 1;
      const lineTotal = data.lineTotal ?? unitPrice;
      const shippingFee = data.shippingFee ?? '0.00';
      const discountAmount = data.discountAmount ?? '0.00';

      // Computed, never hand-written: the `orders_total_matches_components` CHECK
      // would reject a mistyped total before the test it belongs to ever ran.
      const totalAmount = new Prisma.Decimal(data.subtotal)
        .plus(shippingFee)
        .minus(discountAmount)
        .toFixed(2);

      return prisma.order.create({
        data: {
          userId: data.userId,
          orderNumber: data.orderNumber,
          status: data.status,
          subtotal: data.subtotal,
          shippingFee,
          discountAmount,
          totalAmount,
          currency: 'USD',
          shippingRecipientName: 'Order Tester',
          shippingPhone: '+15555550100',
          shippingAddressLine1: '18 Mill Lane',
          shippingAddressLine2: null,
          shippingCity: 'Bristol',
          shippingStateProvince: null,
          shippingPostalCode: 'BS1 4TR',
          shippingCountryCode: 'GB',
          createdAt: data.createdAt,
          items: {
            create: {
              variantId,
              productName: 'Wool Peacoat',
              sku: slug('SKU-coat'),
              variantOptionsSnapshot: [
                { optionName: 'Color', optionValue: 'Navy' },
                { optionName: 'Size', optionValue: 'M' },
              ],
              unitPrice,
              quantity,
              lineTotal,
              createdAt: data.createdAt,
            },
          },
        },
        include: { items: true },
      });
    };

    const older = await seedOrder({
      userId,
      orderNumber: `ORD-20260101-${tag}`,
      status: 'CONFIRMED',
      createdAt: new Date('2026-01-02T09:00:00.000Z'),
      quantity: 2,
      unitPrice: '129.00',
      lineTotal: '258.00',
      subtotal: '258.00',
    });
    olderOrderId = older.id;

    const newer = await seedOrder({
      userId,
      orderNumber: `ORD-20260103-${tag}`,
      status: 'SHIPPED',
      createdAt: new Date('2026-01-04T11:30:00.000Z'),
      shippingFee: '7.50',
      discountAmount: '8.00',
      subtotal: '129.00',
    });
    newerOrderId = newer.id;

    const other = await seedOrder({
      userId: otherUserId,
      orderNumber: `ORD-20260105-${tag}`,
      status: 'PENDING',
      createdAt: new Date('2026-01-05T08:00:00.000Z'),
      subtotal: '129.00',
    });
    otherOrderId = other.id;
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }

    if (!prisma) {
      return;
    }

    // Foreign-key order: lines, then orders, then the catalogue, then the users.
    // Orders go before users because `orders.user_id` is ON DELETE RESTRICT.
    await prisma.orderItem.deleteMany({
      where: { order: { user: { email: { startsWith: `orders-${run}-` } } } },
    });
    await prisma.order.deleteMany({
      where: { user: { email: { startsWith: `orders-${run}-` } } },
    });
    await prisma.inventory.deleteMany({ where: { variant: { productId } } });
    await prisma.productVariant.deleteMany({ where: { productId } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.user.deleteMany({
      where: { email: { startsWith: `orders-${run}-` } },
    });
    await prisma.category.deleteMany({ where: { id: categoryId } });
  });

  describe('GET /orders — the listing', () => {
    it("returns only the caller's orders, newest first", async () => {
      const res = await api('GET', '/orders');

      expect(res.status).toBe(HttpStatus.OK);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.map((row: { id: string }) => row.id)).toEqual([
        newerOrderId,
        olderOrderId,
      ]);
      expect(
        res.body.every((row: { userId: string }) => row.userId === userId),
      ).toBe(true);
    });

    it('orders by createdAt descending, not by insertion order', async () => {
      const body = await getOrders();
      const timestamps = body.map((row: { createdAt: string }) =>
        Date.parse(row.createdAt),
      );

      expect(timestamps).toEqual([...timestamps].sort((a, b) => b - a));
    });

    it('is an empty 200 for a customer who has never ordered', async () => {
      const res = await api('GET', '/orders', { user: newcomerId });

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body).toEqual([]);
    });

    it('exposes exactly the summary fields, and nothing more', async () => {
      const body = await getOrders();

      // Pinned key-for-key, so a column added to `orders` cannot quietly appear in
      // the API, and so nothing account-shaped can leak into a listing.
      expect(Object.keys(body[0]).sort()).toEqual(
        [
          'createdAt',
          'currency',
          'discountAmount',
          'id',
          'itemCount',
          'lineCount',
          'orderNumber',
          'shippingCity',
          'shippingCountryCode',
          'shippingFee',
          'shippingRecipientName',
          'status',
          'subtotal',
          'totalAmount',
          'updatedAt',
          'userId',
        ].sort(),
      );
    });

    it('omits items, the full address and every user column', async () => {
      const body = await getOrders();

      for (const row of body) {
        expect(row).not.toHaveProperty('items');
        expect(row).not.toHaveProperty('passwordHash');
        expect(row).not.toHaveProperty('user');
        expect(row).not.toHaveProperty('email');
        // The three address fields below are the summary's; the rest are detail's.
        expect(row).not.toHaveProperty('shippingPhone');
        expect(row).not.toHaveProperty('shippingAddressLine1');
        expect(row).not.toHaveProperty('shippingPostalCode');
      }
    });

    it('carries the stored figures as fixed two-decimal strings', async () => {
      const [newest] = await getOrders();

      expect(typeof newest.subtotal).toBe('string');
      expect(typeof newest.shippingFee).toBe('string');
      expect(typeof newest.discountAmount).toBe('string');
      expect(typeof newest.totalAmount).toBe('string');
      expect(newest.subtotal).toBe('129.00');
      expect(newest.shippingFee).toBe('7.50');
      expect(newest.discountAmount).toBe('8.00');
      expect(newest.totalAmount).toBe('128.50');
      for (const amount of [
        newest.subtotal,
        newest.shippingFee,
        newest.discountAmount,
        newest.totalAmount,
      ]) {
        expect(amount).toMatch(/^\d+\.\d{2}$/);
      }
    });

    it('reports both counts, distinguishing units from lines', async () => {
      const body = await getOrders();

      expect(body[1]).toMatchObject({ itemCount: 2, lineCount: 1 });
      expect(body[0]).toMatchObject({ itemCount: 1, lineCount: 1 });
    });

    it('returns the status as stored, not assuming PENDING', async () => {
      const body = await getOrders();

      expect(body.map((row: { status: string }) => row.status)).toEqual([
        'SHIPPED',
        'CONFIRMED',
      ]);
    });

    it('never leaks another customer into a listing', async () => {
      const mine = await getOrders();
      const theirs = await getOrders(otherUserId);

      expect(theirs.map((row: { id: string }) => row.id)).toEqual([
        otherOrderId,
      ]);
      expect(mine.map((row: { id: string }) => row.id)).not.toContain(
        otherOrderId,
      );
    });
  });

  describe('GET /orders/:id — the detail view', () => {
    it('returns the order with its items', async () => {
      const res = await getOrder(olderOrderId);

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body).toMatchObject({
        id: olderOrderId,
        userId,
        orderNumber: `ORD-20260101-${tag}`,
        status: 'CONFIRMED',
        subtotal: '258.00',
        totalAmount: '258.00',
        currency: 'USD',
        itemCount: 2,
      });
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0]).toMatchObject({
        orderId: olderOrderId,
        variantId,
        productName: 'Wool Peacoat',
        sku: slug('SKU-coat'),
        unitPrice: '129.00',
        quantity: 2,
        lineTotal: '258.00',
      });
    });

    it('exposes exactly the detail fields, and nothing more', async () => {
      const res = await getOrder(olderOrderId);

      expect(Object.keys(res.body).sort()).toEqual(
        [
          'createdAt',
          'currency',
          'discountAmount',
          'id',
          'itemCount',
          'items',
          'orderNumber',
          'shippingAddressLine1',
          'shippingAddressLine2',
          'shippingCity',
          'shippingCountryCode',
          'shippingFee',
          'shippingPhone',
          'shippingPostalCode',
          'shippingRecipientName',
          'shippingStateProvince',
          'status',
          'subtotal',
          'totalAmount',
          'updatedAt',
          'userId',
        ].sort(),
      );

      expect(Object.keys(res.body.items[0]).sort()).toEqual(
        [
          'createdAt',
          'id',
          'lineTotal',
          'orderId',
          'productName',
          'quantity',
          'sku',
          'unitPrice',
          'variantId',
          'variantOptionsSnapshot',
        ].sort(),
      );
    });

    it('carries the snapshot options as a structured array', async () => {
      const res = await getOrder(olderOrderId);

      expect(res.body.items[0].variantOptionsSnapshot).toEqual([
        { optionName: 'Color', optionValue: 'Navy' },
        { optionName: 'Size', optionValue: 'M' },
      ]);
    });

    it('preserves null and absent address fields as null', async () => {
      const res = await getOrder(olderOrderId);

      expect(res.body.shippingAddressLine2).toBeNull();
      expect(res.body.shippingStateProvince).toBeNull();
      // Populated, so it must not be nulled out by a blanket default.
      expect(res.body.shippingPostalCode).toBe('BS1 4TR');
      expect(res.body.shippingCountryCode).toBe('GB');
    });

    it('serialises item money as strings, exactly as stored', async () => {
      const res = await getOrder(olderOrderId);
      const [item] = res.body.items;

      expect(typeof item.unitPrice).toBe('string');
      expect(typeof item.lineTotal).toBe('string');
      expect(item.unitPrice).toBe('129.00');
      expect(item.lineTotal).toBe('258.00');
    });

    it('returns the newest order as readily as the oldest', async () => {
      const res = await getOrder(newerOrderId);

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.orderNumber).toBe(`ORD-20260103-${tag}`);
      expect(res.body.totalAmount).toBe('128.50');
    });
  });

  describe('identity and ownership', () => {
    it('404s an order belonging to another customer', async () => {
      const res = await getOrder(otherOrderId);

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
    });

    it('gives the same 404 for "not yours" and "does not exist"', async () => {
      const mine = await getOrder(olderOrderId);
      const theirs = await getOrder(otherOrderId);
      const absent = await getOrder(randomUUID());

      expect(mine.status).toBe(HttpStatus.OK);
      expect(theirs.status).toBe(HttpStatus.NOT_FOUND);
      expect(absent.status).toBe(HttpStatus.NOT_FOUND);

      // The same wording in both cases, and no mention of the owning customer, so
      // the endpoint cannot be used to confirm that an order id is real. Only the
      // id the caller supplied differs, which they already know.
      for (const res of [theirs, absent]) {
        expect(res.body.message).toMatch(
          /^Order [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} does not exist$/,
        );
        expect(JSON.stringify(res.body)).not.toContain(otherUserId);
      }
    });

    it('404s a claimed user that does not exist', async () => {
      const ghost = randomUUID();

      expect((await api('GET', '/orders', { user: ghost })).status).toBe(
        HttpStatus.NOT_FOUND,
      );
      expect((await getOrder(olderOrderId, ghost)).status).toBe(
        HttpStatus.NOT_FOUND,
      );
    });

    it('400s a malformed X-User-Id on both routes', async () => {
      const list = await api('GET', '/orders', { user: 'not-a-uuid' });
      const detail = await getOrder(olderOrderId, 'not-a-uuid');

      expect(list.status).toBe(HttpStatus.BAD_REQUEST);
      expect(detail.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('400s a missing X-User-Id on both routes', async () => {
      const list = await api('GET', '/orders', { user: null });
      const detail = await api('GET', `/orders/${olderOrderId}`, {
        user: null,
      });

      expect(list.status).toBe(HttpStatus.BAD_REQUEST);
      expect(detail.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('400s a malformed order id', async () => {
      const res = await api('GET', '/orders/not-a-uuid');

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });
  });

  describe('the API is read-only', () => {
    it('exposes no route that creates an order', async () => {
      const before = await prisma.order.count({ where: { userId } });
      const res = await api('POST', '/orders', {
        body: { lines: [{ variantId, quantity: 1 }] },
      });

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
      expect(await prisma.order.count({ where: { userId } })).toBe(before);
    });

    it('exposes no route that changes an order', async () => {
      const patched = await api('PATCH', `/orders/${olderOrderId}`, {
        body: { status: 'CANCELLED' },
      });
      const replaced = await api('PUT', `/orders/${olderOrderId}`, {
        body: { status: 'CANCELLED' },
      });

      expect(patched.status).toBe(HttpStatus.NOT_FOUND);
      expect(replaced.status).toBe(HttpStatus.NOT_FOUND);
    });

    it('exposes no route that deletes an order', async () => {
      const res = await api('DELETE', `/orders/${olderOrderId}`);

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
      expect(await prisma.order.count({ where: { id: olderOrderId } })).toBe(
        1,
      );
    });

    it('exposes no route that transitions a status', async () => {
      for (const path of [
        `/orders/${olderOrderId}/cancel`,
        `/orders/${olderOrderId}/status`,
        `/orders/${olderOrderId}/confirm`,
      ]) {
        expect((await api('POST', path, { body: {} })).status).toBe(
          HttpStatus.NOT_FOUND,
        );
      }
    });

    it('leaves the stored order untouched after a rejected mutation attempt', async () => {
      const stored = await prisma.order.findUniqueOrThrow({
        where: { id: olderOrderId },
      });

      expect(stored.status).toBe('CONFIRMED');
      expect(stored.totalAmount.toFixed(2)).toBe('258.00');
    });
  });

  describe('snapshots are immutable', () => {
    it('ignores a later rename, reprice and option edit', async () => {
      const before = (await getOrder(olderOrderId)).body;

      await prisma.product.update({
        where: { id: productId },
        data: { name: 'Recycled Wool Peacoat (2026 Edition)' },
      });
      await prisma.productVariant.update({
        where: { id: variantId },
        data: { price: '349.00' },
      });
      await prisma.variantOption.update({
        where: { variantId_optionName: { variantId, optionName: 'Color' } },
        data: { optionValue: 'Black' },
      });

      const after = (await getOrder(olderOrderId)).body;

      // Byte-for-byte identical, which also proves the ordering of the snapshot
      // array is deterministic rather than incidental.
      expect(after).toEqual(before);
      expect(after.items[0].productName).toBe('Wool Peacoat');
      expect(after.items[0].unitPrice).toBe('129.00');
      expect(after.items[0].lineTotal).toBe('258.00');
      expect(after.items[0].variantOptionsSnapshot).toEqual([
        { optionName: 'Color', optionValue: 'Navy' },
        { optionName: 'Size', optionValue: 'M' },
      ]);
    });

    it('is unaffected by deleting the variant options outright', async () => {
      await prisma.variantOption.deleteMany({ where: { variantId } });

      const res = await getOrder(olderOrderId);

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.items[0].variantOptionsSnapshot).toEqual([
        { optionName: 'Color', optionValue: 'Navy' },
        { optionName: 'Size', optionValue: 'M' },
      ]);
      expect(await prisma.variantOption.count({ where: { variantId } })).toBe(
        0,
      );
    });

    it('refuses to delete the variant itself, because history is permanent', async () => {
      await expect(
        prisma.productVariant.delete({ where: { id: variantId } }),
      ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);

      expect(
        await prisma.productVariant.count({ where: { id: variantId } }),
      ).toBe(1);
    });
  });

  describe('order numbers', () => {
    it('stores numbers in the documented shape', async () => {
      const rows = await prisma.order.findMany({
        where: { userId },
        select: { orderNumber: true },
      });

      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.orderNumber).toMatch(OrderNumberGenerator.PATTERN);
      }
    });

    it('generates distinct numbers, all matching that shape', () => {
      const generator = new OrderNumberGenerator();
      const numbers = generator.buildMany(500);

      expect(numbers).toHaveLength(500);
      expect(new Set(numbers).size).toBe(500);
      for (const orderNumber of numbers) {
        expect(orderNumber).toMatch(OrderNumberGenerator.PATTERN);
      }
    });

    it('encodes the UTC date it was minted on, whatever the local time', () => {
      const generator = new OrderNumberGenerator();
      // 23:30 UTC would be the next day in any positive-offset zone; the stamp must
      // still be the UTC date, or the same order could read two different days.
      const orderNumber = generator.build(
        new Date('2026-01-04T23:30:00.000Z'),
      );

      expect(orderNumber.startsWith('ORD-20260104-')).toBe(true);
    });

    it('lets exactly one of two concurrent identical numbers win', async () => {
      const orderNumber = nextOrderNumber('D');
      const attempt = () =>
        prisma.order.create({
          data: {
            userId: newcomerId,
            orderNumber,
            status: 'PENDING',
            subtotal: '10.00',
            totalAmount: '10.00',
            shippingRecipientName: 'Racer',
            shippingPhone: '+15555550101',
            shippingAddressLine1: '1 Race Lane',
            shippingCity: 'Bath',
            shippingCountryCode: 'GB',
          },
        });

      const settled = await Promise.allSettled([attempt(), attempt()]);

      expect(settled.filter((row) => row.status === 'fulfilled')).toHaveLength(
        1,
      );

      const rejected = settled.find((row) => row.status === 'rejected');
      expect(rejected).toBeDefined();
      if (rejected?.status === 'rejected') {
        expect(rejected.reason).toBeInstanceOf(
          Prisma.PrismaClientKnownRequestError,
        );
        expect((rejected.reason as { code: string }).code).toBe('P2002');
      }
    });

    it('stores many concurrent distinct numbers without a duplicate', async () => {
      const generator = new OrderNumberGenerator();
      const numbers = generator.buildMany(25);

      await Promise.all(
        numbers.map((orderNumber, index) =>
          prisma.order.create({
            data: {
              userId: newcomerId,
              orderNumber,
              status: 'PENDING',
              subtotal: '1.00',
              totalAmount: '1.00',
              shippingRecipientName: `Racer ${index}`,
              shippingPhone: '+15555550102',
              shippingAddressLine1: '2 Race Lane',
              shippingCity: 'Bath',
              shippingCountryCode: 'GB',
            },
          }),
        ),
      );

      const rows = await prisma.order.findMany({
        where: { userId: newcomerId },
        select: { orderNumber: true },
      });

      expect(new Set(rows.map((row) => row.orderNumber)).size).toBe(
        rows.length,
      );
    });
  });

  describe('database constraints are the final protection', () => {
    it('refuses a negative subtotal', async () => {
      await expectCheckViolation(
        prisma.order.create({
          data: order(nextOrderNumber('E'), { subtotal: '-1.00' }),
        }),
        'orders_subtotal_non_negative',
      );
    });

    it('refuses a negative shipping fee', async () => {
      await expectCheckViolation(
        prisma.order.create({
          data: order(nextOrderNumber('E'), { shippingFee: '-0.01' }),
        }),
        'orders_shipping_fee_non_negative',
      );
    });

    it('refuses a negative discount', async () => {
      await expectCheckViolation(
        prisma.order.create({
          data: order(nextOrderNumber('E'), { discountAmount: '-5.00' }),
        }),
        'orders_discount_amount_non_negative',
      );
    });

    it('refuses a total that disagrees with its components', async () => {
      await expectCheckViolation(
        prisma.order.create({
          data: order(nextOrderNumber('E'), {
            subtotal: '10.00',
            shippingFee: '2.50',
            discountAmount: '1.00',
            totalAmount: '11.00',
          }),
        }),
        'orders_total_matches_components',
      );
    });

    it('refuses a discount larger than the goods, which implies a negative total', async () => {
      await expectCheckViolation(
        prisma.order.create({
          data: order(nextOrderNumber('E'), {
            discountAmount: '10.01',
            totalAmount: '-0.01',
          }),
        }),
        'orders_total_amount_non_negative',
      );
    });

    it('refuses a lowercase currency and a lowercase country code', async () => {
      await expectCheckViolation(
        prisma.order.create({
          data: order(nextOrderNumber('E'), { currency: 'usd' }),
        }),
        'orders_currency_iso_4217_shape',
      );

      await expectCheckViolation(
        prisma.order.create({
          data: order(nextOrderNumber('E'), { shippingCountryCode: 'gb' }),
        }),
        'orders_shipping_country_code_iso_3166_shape',
      );
    });

    it('refuses a duplicate order number outright', async () => {
      const orderNumber = nextOrderNumber('E');
      await prisma.order.create({ data: order(orderNumber) });

      await expect(
        prisma.order.create({ data: order(orderNumber) }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('refuses a line whose total is not unitPrice × quantity', async () => {
      await expectCheckViolation(
        prisma.order.create({
          data: {
            ...order(nextOrderNumber('F')),
            items: { create: line({ quantity: 3, lineTotal: '25.00' }) },
          },
        }),
        'order_items_line_total_matches_unit_price_times_quantity',
      );
    });

    it('refuses a zero, negative or fractional quantity', async () => {
      for (const quantity of [0, -2, 1.5]) {
        await expectItemCheckViolation(
          prisma.order.create({
            data: {
              ...order(nextOrderNumber('F')),
              items: {
                create: line({
                  quantity,
                  // Consistent with the quantity, so the rejection cannot be about
                  // the arithmetic identity.
                  lineTotal: (10 * quantity).toFixed(2),
                }),
              },
            },
          }),
        );
      }
    });

    it('refuses a free line', async () => {
      await expectItemCheckViolation(
        prisma.order.create({
          data: {
            ...order(nextOrderNumber('F')),
            items: { create: line({ unitPrice: '0.00', lineTotal: '0.00' }) },
          },
        }),
      );
    });

    it('refuses a negative line total even when the arithmetic agrees', async () => {
      await expectItemCheckViolation(
        prisma.order.create({
          data: {
            ...order(nextOrderNumber('F')),
            items: {
              create: line({
                unitPrice: '-10.00',
                quantity: 1,
                lineTotal: '-10.00',
              }),
            },
          },
        }),
      );
    });

    it('declares every documented CHECK constraint', async () => {
      const constraints = await prisma.$queryRawUnsafe<
        { conname: string; pg_get_constraintdef: string }[]
      >(
        `select conname, pg_get_constraintdef(oid) as pg_get_constraintdef
           from pg_constraint
          where conrelid in ('orders'::regclass, 'order_items'::regclass)
            and contype = 'c'
          order by conname`,
      );

      // Pinned by expression, so a constraint cannot be silently weakened — say
      // `>= 0` weakened to `> 0`, or the identity check dropped — without a test
      // failing here.
      expect(constraints).toEqual([
        {
          conname: 'order_items_line_total_matches_unit_price_times_quantity',
          pg_get_constraintdef:
            'CHECK ((line_total = (unit_price * (quantity)::numeric)))',
        },
        {
          conname: 'order_items_line_total_positive',
          pg_get_constraintdef: 'CHECK ((line_total > (0)::numeric))',
        },
        {
          conname: 'order_items_quantity_positive',
          pg_get_constraintdef: 'CHECK ((quantity > 0))',
        },
        {
          conname: 'order_items_unit_price_positive',
          pg_get_constraintdef: 'CHECK ((unit_price > (0)::numeric))',
        },
        {
          conname: 'orders_currency_iso_4217_shape',
          pg_get_constraintdef: `CHECK ((currency ~ '^[A-Z]{3}$'::text))`,
        },
        {
          conname: 'orders_discount_amount_non_negative',
          pg_get_constraintdef: 'CHECK ((discount_amount >= (0)::numeric))',
        },
        {
          conname: 'orders_shipping_country_code_iso_3166_shape',
          pg_get_constraintdef: `CHECK ((shipping_country_code ~ '^[A-Z]{2}$'::text))`,
        },
        {
          conname: 'orders_shipping_fee_non_negative',
          pg_get_constraintdef: 'CHECK ((shipping_fee >= (0)::numeric))',
        },
        {
          conname: 'orders_subtotal_non_negative',
          pg_get_constraintdef: 'CHECK ((subtotal >= (0)::numeric))',
        },
        {
          conname: 'orders_total_amount_non_negative',
          pg_get_constraintdef: 'CHECK ((total_amount >= (0)::numeric))',
        },
        {
          conname: 'orders_total_matches_components',
          pg_get_constraintdef:
            'CHECK ((total_amount = ((subtotal + shipping_fee) - discount_amount)))',
        },
      ]);
    });

    it('refuses a line referencing a variant that does not exist', async () => {
      await expect(
        prisma.order.create({
          data: {
            ...order(nextOrderNumber('G')),
            items: { create: line({ variantId: randomUUID() }) },
          },
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
    });

    it('refuses an order for a user that does not exist', async () => {
      await expect(
        prisma.order.create({
          data: order(nextOrderNumber('G'), { userId: randomUUID() }),
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
    });
  });

  describe('deletion behaviour', () => {
    it('refuses to delete a customer who has orders', async () => {
      const ordersBefore = await prisma.order.count({ where: { userId } });
      expect(ordersBefore).toBeGreaterThan(0);

      await expect(
        prisma.user.delete({ where: { id: userId } }),
      ).rejects.toMatchObject({ code: 'P2003' });

      // The customer is still here, with their history intact.
      expect(await prisma.user.count({ where: { id: userId } })).toBe(1);
      expect(await prisma.order.count({ where: { userId } })).toBe(
        ordersBefore,
      );
    });

    it('cascades from an order to its lines', async () => {
      const throwaway = await prisma.order.create({
        data: {
          userId: newcomerId,
          orderNumber: nextOrderNumber('H'),
          status: 'PENDING',
          subtotal: '20.00',
          totalAmount: '20.00',
          shippingRecipientName: 'Throwaway',
          shippingPhone: '+15555550104',
          shippingAddressLine1: '4 Drop Lane',
          shippingCity: 'Leeds',
          shippingCountryCode: 'GB',
          items: { create: [line(), line({ quantity: 1 })] },
        },
        include: { items: true },
      });

      expect(throwaway.items).toHaveLength(2);

      await prisma.order.delete({ where: { id: throwaway.id } });

      expect(
        await prisma.orderItem.count({ where: { orderId: throwaway.id } }),
      ).toBe(0);
      // The cascade took the lines, not the catalogue they referenced.
      expect(
        await prisma.productVariant.count({ where: { id: variantId } }),
      ).toBe(1);
    });

    it('allows a customer to be deleted once they have no orders', async () => {
      const disposable = await prisma.user.create({
        data: {
          firstName: 'Order',
          lastName: 'Disposable',
          email: email('disposable'),
          passwordHash: 'argon2-not-a-real-hash',
          status: 'ACTIVE',
        },
      });

      await expect(
        prisma.user.delete({ where: { id: disposable.id } }),
      ).resolves.toMatchObject({ id: disposable.id });
    });
  });

  describe('column and index shape', () => {
    it('stores every amount as NUMERIC(12,2) and never as a float', async () => {
      const columns = await prisma.$queryRawUnsafe<
        {
          column_name: string;
          numeric_precision: number | null;
          numeric_scale: number | null;
        }[]
      >(
        `select column_name, numeric_precision, numeric_scale
           from information_schema.columns
          where table_name in ('orders', 'order_items')
            and data_type = 'numeric'`,
      );

      expect(columns.length).toBeGreaterThan(0);
      for (const column of columns) {
        expect(column.numeric_precision).toBe(12);
        expect(column.numeric_scale).toBe(2);
      }
      expect(columns.map((column) => column.column_name).sort()).toEqual(
        [
          'discount_amount',
          'line_total',
          'shipping_fee',
          'subtotal',
          'total_amount',
          'unit_price',
        ].sort(),
      );
    });

    it('indexes only what a query in this phase actually performs', async () => {
      const orders = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
        `select indexname from pg_indexes where tablename = 'orders'`,
      );

      // The primary key, the order-number uniqueness guarantee, and the one
      // composite that serves "this user's orders, newest first". No index on
      // `status`: nothing in this phase filters by it.
      expect(orders.map((row) => row.indexname).sort()).toEqual([
        'orders_order_number_key',
        'orders_pkey',
        'orders_user_id_created_at_id_idx',
      ]);

      const items = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
        `select indexname from pg_indexes where tablename = 'order_items'`,
      );
      expect(items.map((row) => row.indexname).sort()).toEqual([
        'order_items_order_id_idx',
        'order_items_pkey',
        'order_items_variant_id_idx',
      ]);
    });

    it('makes the listing index match the ordering the query asks for', async () => {
      const definition = await prisma.$queryRawUnsafe<
        { indexdef: string }[]
      >(
        `select indexdef from pg_indexes where indexname = 'orders_user_id_created_at_id_idx'`,
      );

      expect(definition[0].indexdef).toContain('user_id, created_at DESC, id DESC');
    });

    it('gives order_items no updated_at and orders a free-form status', async () => {
      const itemColumns = await prisma.$queryRawUnsafe<{
        column_name: string;
      }[]>(
        `select column_name from information_schema.columns where table_name = 'order_items'`,
      );
      const statusColumn = await prisma.$queryRawUnsafe<{
        column_name: string;
        data_type: string;
      }[]>(
        `select column_name, data_type from information_schema.columns
          where table_name = 'orders' and column_name = 'status'`,
      );

      expect(itemColumns.map((column) => column.column_name)).not.toContain(
        'updated_at',
      );
      // Free-form text, mirroring `users.status`: adding a status must never
      // require a migration.
      expect(statusColumn).toHaveLength(1);
      expect(statusColumn[0].data_type).toBe('character varying');
    });
  });
});
