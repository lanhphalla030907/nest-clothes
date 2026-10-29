import 'dotenv/config';
import {
  HttpStatus,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module.js';
import { Role } from '../src/generated/prisma/enums.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import {
  bearerHeaders,
  tokenIssuerFor,
  type IssueToken,
} from './support/e2e-auth.js';

/**
 * Read-only administrative order management against a **real PostgreSQL**.
 *
 * The controller spec proves the authorisation matrix and query validation with
 * the service stubbed. This file proves the parts only a database can: the global
 * page and its total, ordering, status/date/search predicates (including LIKE
 * wildcard escaping), the explicit customer projection, and that the detail view
 * reads order-item snapshots rather than live catalogue rows.
 *
 * Every fixture is namespaced by a per-run token and removed in `afterAll`, in
 * dependency order: payments and order items before orders, because both
 * reference an order with `ON DELETE RESTRICT`.
 */
describe('Admin orders (PostgreSQL)', () => {
  const run = randomUUID().slice(0, 8);
  const orderNumber = (suffix: string) => `ORD-${run}-${suffix}`;

  let app: INestApplication;
  let prisma: PrismaService;
  let base: string;
  let issueToken: IssueToken;

  let adminId: string;
  let customerAId: string;
  let customerBId: string;
  let categoryId: string;
  let productId: string;
  let variantId: string;

  /** Orders this suite created, in creation order: A1, A2, B1. */
  const orderIds: string[] = [];
  let a1: { id: string; orderNumber: string };
  let a2: { id: string; orderNumber: string };
  let b1: { id: string; orderNumber: string };

  const api = async (
    method: string,
    path: string,
    options: {
      user?: string;
      body?: unknown;
      rawHeaders?: Record<string, string>;
    } = {},
  ) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(options.body === undefined
          ? {}
          : { 'Content-Type': 'application/json' }),
        ...(options.user === undefined
          ? {}
          : bearerHeaders(issueToken, false)(options.user)),
        ...options.rawHeaders,
      },
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

  const search = (value: string) => encodeURIComponent(value);

  const createOrder = async (input: {
    userId: string;
    suffix: string;
    status: string;
    createdAt: string;
    recipientName: string;
    city: string;
  }) =>
    prisma.order.create({
      data: {
        userId: input.userId,
        orderNumber: orderNumber(input.suffix),
        status: input.status,
        subtotal: '129.00',
        shippingFee: '7.50',
        discountAmount: '8.00',
        totalAmount: '128.50',
        currency: 'USD',
        shippingRecipientName: input.recipientName,
        shippingPhone: '+15555550100',
        shippingAddressLine1: '18 Mill Lane',
        shippingAddressLine2: null,
        shippingCity: input.city,
        shippingStateProvince: null,
        shippingPostalCode: 'BS1 4TR',
        shippingCountryCode: 'GB',
        createdAt: new Date(input.createdAt),
        updatedAt: new Date(input.createdAt),
        items: {
          create: [
            {
              variantId,
              productName: 'Original Snapshot Coat',
              sku: `ADMIN-ORD-${run}`,
              variantOptionsSnapshot: [
                { optionName: 'Color', optionValue: 'Navy' },
                { optionName: 'Size', optionValue: 'M' },
              ],
              unitPrice: '129.00',
              quantity: 1,
              lineTotal: '129.00',
            },
          ],
        },
      },
      select: { id: true, orderNumber: true },
    });

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        'DATABASE_URL is not set — the admin order integration tests need a real PostgreSQL instance',
      );
    }

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
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
    issueToken = tokenIssuerFor(app);

    adminId = randomUUID();
    customerAId = randomUUID();
    customerBId = randomUUID();

    await prisma.user.createMany({
      data: [
        {
          id: adminId,
          firstName: 'Admin',
          lastName: run,
          email: `admin-orders-${run}@example.test`,
          passwordHash: 'not-used-here',
          status: 'ACTIVE',
          role: Role.ADMIN,
        },
        {
          id: customerAId,
          firstName: `Alpha${run}`,
          lastName: `Zephyr${run}`,
          email: `alpha-${run}@example.test`,
          passwordHash: 'super-secret-hash',
          status: 'ACTIVE',
          role: Role.CUSTOMER,
        },
        {
          id: customerBId,
          firstName: `Beta${run}`,
          lastName: `Quartz${run}`,
          email: `beta-${run}@example.test`,
          passwordHash: 'super-secret-hash',
          status: 'ACTIVE',
          role: Role.CUSTOMER,
        },
      ],
    });

    const category = await prisma.category.create({
      data: { name: `Admin orders ${run}`, slug: `admin-orders-${run}` },
    });
    categoryId = category.id;

    const product = await prisma.product.create({
      data: {
        categoryId,
        name: 'Original Snapshot Coat',
        slug: `admin-orders-${run}`,
        basePrice: '129.00',
        status: 'ACTIVE',
      },
    });
    productId = product.id;

    const variant = await prisma.productVariant.create({
      data: { productId, sku: `ADMIN-ORD-${run}`, price: '129.00' },
    });
    variantId = variant.id;

    a1 = await createOrder({
      userId: customerAId,
      suffix: '1',
      status: 'PENDING',
      createdAt: '2026-05-01T10:00:00.000Z',
      recipientName: 'Alpha Zephyr',
      city: 'Bristol',
    });
    a2 = await createOrder({
      userId: customerAId,
      suffix: '2',
      status: 'CONFIRMED',
      createdAt: '2026-05-02T10:00:00.000Z',
      recipientName: 'Alpha Zephyr',
      city: 'Leeds',
    });
    b1 = await createOrder({
      userId: customerBId,
      suffix: '3',
      status: 'SHIPPED',
      createdAt: '2026-05-03T10:00:00.000Z',
      recipientName: 'Beta Quartz',
      city: 'York',
    });
    orderIds.push(a1.id, a2.id, b1.id);

    await prisma.payment.create({
      data: {
        orderId: a1.id,
        provider: 'ABA_PAYWAY',
        transactionId: `PW${run}1`,
        status: 'PENDING',
        amount: '128.50',
        currency: 'USD',
        qrPayload: {
          qrString: 'SHOULD-NOT-LEAK-QR',
          qrImage: 'SHOULD-NOT-LEAK-IMAGE',
          lifetimeMinutes: 5,
          expiresAt: '2026-05-01T10:05:00.000Z',
        },
      },
    });

    await prisma.payment.create({
      data: {
        orderId: a2.id,
        provider: 'ABA_PAYWAY',
        transactionId: `PW${run}2`,
        status: 'PAID',
        amount: '128.50',
        currency: 'USD',
        paymentMethod: 'ABA Pay',
        providerReference: 'REF-ADMIN-ORDERS',
        paidAt: new Date('2026-05-02T10:05:00.000Z'),
        qrPayload: {
          qrString: 'SHOULD-NOT-LEAK-QR',
          lifetimeMinutes: 5,
          expiresAt: '2026-05-02T10:05:00.000Z',
        },
      },
    });

    // The order lines were written from this name. Changing the live product must
    // not change what the order detail says was sold.
    await prisma.product.update({
      where: { id: productId },
      data: { name: 'Renamed After The Sale' },
    });
  }, 120_000);

  afterAll(async () => {
    if (prisma) {
      await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.orderItem.deleteMany({
        where: { orderId: { in: orderIds } },
      });
      await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
      if (variantId) {
        await prisma.productVariant.deleteMany({ where: { id: variantId } });
      }
      if (productId) {
        await prisma.product.deleteMany({ where: { id: productId } });
      }
      if (categoryId) {
        await prisma.category.deleteMany({ where: { id: categoryId } });
      }
      await prisma.user.deleteMany({
        where: { id: { in: [adminId, customerAId, customerBId] } },
      });
    }
    await app?.close();
  });

  describe('authorisation', () => {
    it('refuses an unauthenticated caller with 401', async () => {
      const res = await api('GET', '/admin/orders');

      expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it('refuses an authenticated customer with 403', async () => {
      const res = await api('GET', '/admin/orders', { user: customerAId });

      expect(res.status).toBe(HttpStatus.FORBIDDEN);
    });

    it('refuses a customer on the detail route too', async () => {
      const res = await api('GET', `/admin/orders/${a1.id}`, {
        user: customerAId,
      });

      expect(res.status).toBe(HttpStatus.FORBIDDEN);
    });

    it('serves an admin', async () => {
      const res = await api(
        'GET',
        `/admin/orders?search=${search(`ORD-${run}`)}`,
        {
          user: adminId,
        },
      );

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.pagination.total).toBe(3);
    });
  });

  describe('the listing', () => {
    const list = (query: string) =>
      api('GET', `/admin/orders?${query}`, { user: adminId });

    it('returns a page and a pagination block, newest first', async () => {
      const res = await list(`search=${search(`ORD-${run}`)}`);

      expect(res.status).toBe(HttpStatus.OK);
      expect(
        res.body.items.map((o: { orderNumber: string }) => o.orderNumber),
      ).toEqual([b1.orderNumber, a2.orderNumber, a1.orderNumber]);
      expect(res.body.pagination).toEqual({
        page: 1,
        limit: 20,
        total: 3,
        totalPages: 1,
      });
    });

    it('paginates, with a total that describes the same filters', async () => {
      const first = await list(`search=${search(`ORD-${run}`)}&page=1&limit=2`);
      const second = await list(
        `search=${search(`ORD-${run}`)}&page=2&limit=2`,
      );

      expect(first.body.items).toHaveLength(2);
      expect(first.body.pagination).toEqual({
        page: 1,
        limit: 2,
        total: 3,
        totalPages: 2,
      });
      expect(second.body.items).toHaveLength(1);
      expect(second.body.items[0].id).toBe(a1.id);
      expect(second.body.pagination.total).toBe(3);
    });

    it('filters by status', async () => {
      const res = await list(`search=${search(`ORD-${run}`)}&status=CONFIRMED`);

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.items.map((o: { id: string }) => o.id)).toEqual([a2.id]);
    });

    it('filters inclusively by createdAt', async () => {
      const res = await list(
        `search=${search(`ORD-${run}`)}&createdFrom=${encodeURIComponent(
          '2026-05-02T00:00:00.000Z',
        )}&createdTo=${encodeURIComponent('2026-05-02T23:59:59.000Z')}`,
      );

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.items.map((o: { id: string }) => o.id)).toEqual([a2.id]);
    });

    it('searches by order-number prefix', async () => {
      const res = await list(`search=${search(orderNumber('2'))}`);

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.items.map((o: { id: string }) => o.id)).toEqual([a2.id]);
    });

    it.each([
      ['first name', `Alpha${run}`],
      ['last name', `Zephyr${run}`],
      ['email', `alpha-${run}@example.test`],
    ])('searches by customer %s', async (_label, term) => {
      const res = await list(`search=${search(term)}`);

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.items.map((o: { id: string }) => o.id)).toEqual([
        a2.id,
        a1.id,
      ]);
    });

    it('treats LIKE wildcards literally rather than matching every order', async () => {
      const res = await list(`search=${search('%')}`);

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.items).toEqual([]);
      expect(res.body.pagination.total).toBe(0);
    });

    it('exposes a safe customer and payment summary, never a credential or QR', async () => {
      const res = await list(`search=${search(`ORD-${run}`)}`);

      const paid = res.body.items.find((o: { id: string }) => o.id === a2.id);
      const unpaid = res.body.items.find((o: { id: string }) => o.id === a1.id);
      const noAttempt = res.body.items.find(
        (o: { id: string }) => o.id === b1.id,
      );

      expect(paid.customer).toEqual({
        id: customerAId,
        firstName: `Alpha${run}`,
        lastName: `Zephyr${run}`,
        email: `alpha-${run}@example.test`,
      });
      expect(paid.hasPaidPayment).toBe(true);
      expect(paid.payment).toMatchObject({
        status: 'PAID',
        provider: 'ABA_PAYWAY',
        amount: '128.50',
        currency: 'USD',
      });
      expect(unpaid.hasPaidPayment).toBe(false);
      expect(unpaid.payment).toMatchObject({ status: 'PENDING' });
      expect(noAttempt.payment).toBeNull();
      expect(noAttempt.hasPaidPayment).toBe(false);

      const text = JSON.stringify(res.body);
      expect(text).not.toContain('passwordHash');
      expect(text).not.toContain('super-secret-hash');
      expect(text).not.toContain('qrPayload');
      expect(text).not.toContain('SHOULD-NOT-LEAK');
    });

    it('uses fixed two-decimal strings for money and counts units', async () => {
      const res = await list(`search=${search(orderNumber('2'))}`);
      const order = res.body.items[0];

      expect(order.subtotal).toBe('129.00');
      expect(order.shippingFee).toBe('7.50');
      expect(order.discountAmount).toBe('8.00');
      expect(order.totalAmount).toBe('128.50');
      expect(order.itemCount).toBe(1);
      expect(order.lineCount).toBe(1);
      expect(typeof order.totalAmount).toBe('string');
    });

    it.each([
      'page=0',
      'page=abc',
      'limit=0',
      'limit=101',
      'status=REFUNDED',
      'createdFrom=not-a-date',
    ])('rejects %s with 400', async (query) => {
      const res = await list(query);

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('rejects a reversed date range with 400', async () => {
      const res = await list(
        `createdFrom=${encodeURIComponent(
          '2026-05-03T00:00:00.000Z',
        )}&createdTo=${encodeURIComponent('2026-05-01T00:00:00.000Z')}`,
      );

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('rejects an unknown query parameter with 400', async () => {
      const res = await list('customerId=someone');

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });
  });

  describe('the detail view', () => {
    it('returns the order, safe customer, snapshots and safe payments', async () => {
      const res = await api('GET', `/admin/orders/${a2.id}`, {
        user: adminId,
      });

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body).toMatchObject({
        id: a2.id,
        orderNumber: a2.orderNumber,
        status: 'CONFIRMED',
        subtotal: '129.00',
        shippingFee: '7.50',
        discountAmount: '8.00',
        totalAmount: '128.50',
        currency: 'USD',
        shippingRecipientName: 'Alpha Zephyr',
        shippingPhone: '+15555550100',
        shippingAddressLine1: '18 Mill Lane',
        shippingAddressLine2: null,
        shippingCity: 'Leeds',
        shippingStateProvince: null,
        shippingPostalCode: 'BS1 4TR',
        shippingCountryCode: 'GB',
        itemCount: 1,
        lineCount: 1,
        customer: {
          id: customerAId,
          firstName: `Alpha${run}`,
          lastName: `Zephyr${run}`,
          email: `alpha-${run}@example.test`,
        },
      });
      expect(res.body.items[0]).toMatchObject({
        productName: 'Original Snapshot Coat',
        sku: `ADMIN-ORD-${run}`,
        variantOptionsSnapshot: [
          { optionName: 'Color', optionValue: 'Navy' },
          { optionName: 'Size', optionValue: 'M' },
        ],
        unitPrice: '129.00',
        quantity: 1,
        lineTotal: '129.00',
      });
      expect(res.body.payments).toHaveLength(1);
      expect(res.body.payments[0]).toMatchObject({
        provider: 'ABA_PAYWAY',
        transactionId: `PW${run}2`,
        status: 'PAID',
        amount: '128.50',
        currency: 'USD',
        paymentMethod: 'ABA Pay',
        providerReference: 'REF-ADMIN-ORDERS',
      });
      expect(res.body.payments[0].paidAt).toBe('2026-05-02T10:05:00.000Z');
    });

    it('keeps the sale-time snapshot after the live product is renamed', async () => {
      const res = await api('GET', `/admin/orders/${a2.id}`, {
        user: adminId,
      });

      expect(res.body.items[0].productName).toBe('Original Snapshot Coat');
      expect(res.body.items[0].productName).not.toBe('Renamed After The Sale');
    });

    it('never returns a password hash, QR payload or QR string', async () => {
      const res = await api('GET', `/admin/orders/${a1.id}`, {
        user: adminId,
      });
      const text = JSON.stringify(res.body);

      expect(res.status).toBe(HttpStatus.OK);
      expect(text).not.toContain('passwordHash');
      expect(text).not.toContain('super-secret-hash');
      expect(text).not.toContain('qrPayload');
      expect(text).not.toContain('qrString');
      expect(text).not.toContain('SHOULD-NOT-LEAK');
    });

    it('404s an unknown order', async () => {
      const res = await api('GET', `/admin/orders/${randomUUID()}`, {
        user: adminId,
      });

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
    });

    it('rejects a malformed id with 400', async () => {
      const res = await api('GET', '/admin/orders/not-a-uuid', {
        user: adminId,
      });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });
  });

  describe('the customer routes still enforce ownership', () => {
    it('shows each customer only their own orders', async () => {
      const a = await api('GET', '/orders', { user: customerAId });
      const b = await api('GET', '/orders', { user: customerBId });

      expect(a.status).toBe(HttpStatus.OK);
      expect(a.body.map((o: { id: string }) => o.id).sort()).toEqual(
        [a1.id, a2.id].sort(),
      );
      expect(b.status).toBe(HttpStatus.OK);
      expect(b.body.map((o: { id: string }) => o.id)).toEqual([b1.id]);
    });

    it("404s one customer reading another customer's order", async () => {
      const res = await api('GET', `/orders/${b1.id}`, { user: customerAId });

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
    });
  });
});
