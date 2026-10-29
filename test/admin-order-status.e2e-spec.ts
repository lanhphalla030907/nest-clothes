import 'dotenv/config';
import {
  HttpStatus,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { Role } from '../src/generated/prisma/enums.js';
import {
  PAYWAY_HTTP_CLIENT,
  type PaywayHttpClient,
  type PaywayHttpResponse,
} from '../src/payments/payway/payway.types.js';
import { PAYWAY_PATHS } from '../src/payments/payway/payway.constants.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import {
  bearerHeaders,
  tokenIssuerFor,
  type IssueToken,
} from './support/e2e-auth.js';

/**
 * Administrative order status transitions against a **real PostgreSQL** database.
 *
 * The unit suites prove which rules the service intends. This file proves the parts
 * only PostgreSQL and the real kernel can settle:
 *
 * - `POST /admin/orders/:id/cancel` releases exactly one reservation and refuses a
 *   paid order; a failed release rolls the status change back.
 * - `POST /admin/orders/:id/ship` commits exactly one reservation, refuses an
 *   unconfirmed or unpaid order, and rolls back when stock is incoherent.
 * - two simultaneous requests can only produce one movement, because the status
 *   update is the guard and the row lock serialises the losers.
 * - the verified PayWay callback still owns `PENDING -> CONFIRMED`; a late callback
 *   after cancellation records the money but cannot move stock a second time.
 *
 * Every fixture is namespaced by a per-run token and removed in `afterAll`.
 */
describe('Admin order status transitions (PostgreSQL)', () => {
  const run = randomUUID().slice(0, 8);
  const email = (name: string) => `admin-status-${run}-${name}@example.test`;
  const slug = (name: string) => `admin-status-${run}-${name}`;

  let app: INestApplication;
  let prisma: PrismaService;
  let base: string;
  let issueToken: IssueToken;
  let headers: (id: string) => Record<string, string>;

  let adminId: string;
  let customerId: string;
  let categoryId: string;
  let variantA: string;
  let variantB: string;

  let orderCounter = 0;
  let transactionCounter = 0;

  const suiteUsers: string[] = [];

  /** The stubbed provider. Only the callback's check-transaction call is used here. */
  const provider = {
    checkAmount: '0.00',
  };

  const checkResponse = (transactionId: string): PaywayHttpResponse => ({
    ok: true,
    status: 200,
    text: () =>
      Promise.resolve(
        JSON.stringify({
          status: {
            code: '00',
            message: 'Success',
            tran_id: transactionId,
          },
          data: {
            payment_status_code: 0,
            payment_status: 'APPROVED',
            total_amount: provider.checkAmount,
            payment_amount: provider.checkAmount,
            payment_currency: 'USD',
            apv: 'APV-ADMIN-STATUS',
          },
        }),
      ),
  });

  const stubClient: PaywayHttpClient = (url, init) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    const isCheck = url.endsWith(PAYWAY_PATHS.checkTransaction);

    if (!isCheck) {
      throw new Error(`Unexpected PayWay call in this suite: ${url}`);
    }

    return Promise.resolve(checkResponse(String(body['tran_id'])));
  };

  const api = async (
    method: string,
    path: string,
    options: { user?: string; body?: unknown } = {},
  ) => {
    const requestHeaders: Record<string, string> = {};

    if (options.user !== undefined) {
      Object.assign(requestHeaders, headers(options.user));
    }

    if (options.body !== undefined) {
      requestHeaders['Content-Type'] = 'application/json';
    }

    const response = await fetch(`${base}${path}`, {
      method,
      headers: requestHeaders,
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    });

    const text = await response.text();

    return {
      status: response.status,
      body:
        text.length === 0
          ? undefined
          : (JSON.parse(text) as Record<string, unknown>),
    };
  };

  const resetStock = async (): Promise<void> => {
    await prisma.inventory.updateMany({
      where: { variantId: { in: [variantA, variantB] } },
      data: { quantity: 100, reservedQuantity: 0 },
    });
  };

  const createOrder = async (
    options: {
      status?: string;
      lines?: { variantId: string; quantity: number }[];
    } = {},
  ) => {
    const lines = options.lines ?? [{ variantId: variantA, quantity: 2 }];
    const unitPrice = '10.00';
    const subtotal = lines
      .reduce((total, line) => total + 10 * line.quantity, 0)
      .toFixed(2);
    orderCounter += 1;

    return prisma.order.create({
      data: {
        userId: customerId,
        orderNumber: `AST-${run}-${orderCounter}`,
        status: options.status ?? 'PENDING',
        subtotal,
        shippingFee: '0.00',
        discountAmount: '0.00',
        totalAmount: subtotal,
        currency: 'USD',
        shippingRecipientName: 'Admin Status Tester',
        shippingPhone: '+15555550100',
        shippingAddressLine1: '18 Mill Lane',
        shippingCity: 'Bristol',
        shippingPostalCode: 'BS1 4TR',
        shippingCountryCode: 'GB',
        items: {
          create: lines.map((line) => ({
            variantId: line.variantId,
            productName: 'Admin Status Coat',
            sku: slug('order-line'),
            variantOptionsSnapshot: [],
            unitPrice,
            quantity: line.quantity,
            lineTotal: new Prisma.Decimal(unitPrice)
              .times(line.quantity)
              .toFixed(2),
          })),
        },
      },
    });
  };

  const createPayment = async (
    orderId: string,
    status: 'PENDING' | 'PAID',
    amount: string,
    transactionId = `PW${run}${String((transactionCounter += 1)).padStart(4, '0')}`,
  ) =>
    prisma.payment.create({
      data: {
        orderId,
        provider: 'ABA_PAYWAY',
        transactionId,
        status,
        amount,
        currency: 'USD',
        paidAt: status === 'PAID' ? new Date() : null,
      },
    });

  const orderStatus = async (orderId: string): Promise<string> =>
    (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status;

  const inventoryOf = async (variantId: string) =>
    prisma.inventory.findUniqueOrThrow({ where: { variantId } });

  const cancel = (orderId: string, user = adminId) =>
    api('POST', `/admin/orders/${orderId}/cancel`, { user });

  const ship = (orderId: string, user = adminId) =>
    api('POST', `/admin/orders/${orderId}/ship`, { user });

  const callback = (transactionId: string) =>
    api('POST', '/payments/aba-payway/callback', {
      body: { merchant_ref: transactionId },
    });

  /**
   * Fake PayWay configuration, installed before the module compiles. The stubbed
   * HTTP client never signs anything, so these only need to be present and
   * well-formed. Restored afterwards so the suite cannot leak configuration.
   */
  const FAKE_PAYWAY_ENV = {
    PAYWAY_MERCHANT_ID: 'test-merchant',
    PAYWAY_API_KEY: 'test-api-key-not-a-real-secret',
    PAYWAY_CALLBACK_URL:
      'https://api.example.test/payments/aba-payway/callback',
  } as const;

  const savedPaywayEnv = new Map<string, string | undefined>();

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        'DATABASE_URL is not set — the admin order status integration tests need a real PostgreSQL instance',
      );
    }

    for (const [name, value] of Object.entries(FAKE_PAYWAY_ENV)) {
      savedPaywayEnv.set(name, process.env[name]);
      process.env[name] = value;
    }

    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PAYWAY_HTTP_CLIENT)
      .useValue(stubClient)
      .compile();

    app = module.createNestApplication();
    issueToken = tokenIssuerFor(app);
    headers = bearerHeaders(issueToken);
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
      data: { name: `Admin Status ${run}`, slug: slug('category') },
    });
    categoryId = category.id;

    const createUser = async (name: string, role: Role) =>
      prisma.user.create({
        data: {
          firstName: 'Admin',
          lastName: 'Tester',
          email: email(name),
          passwordHash: 'argon2-not-a-real-hash',
          status: 'ACTIVE',
          role,
        },
      });

    adminId = (await createUser('admin', Role.ADMIN)).id;
    customerId = (await createUser('customer', Role.CUSTOMER)).id;
    suiteUsers.push(adminId, customerId);

    const product = await prisma.product.create({
      data: {
        categoryId,
        name: 'Admin Status Coat',
        slug: slug('product'),
        basePrice: '10.00',
        status: 'ACTIVE',
      },
    });

    const variants = await Promise.all(
      ['a', 'b'].map((suffix) =>
        prisma.productVariant.create({
          data: {
            productId: product.id,
            sku: slug(`sku-${suffix}`),
            price: '10.00',
          },
        }),
      ),
    );
    variantA = variants[0]!.id;
    variantB = variants[1]!.id;

    await prisma.inventory.createMany({
      data: [
        { variantId: variantA, quantity: 100, reservedQuantity: 0 },
        { variantId: variantB, quantity: 100, reservedQuantity: 0 },
      ],
    });
  });

  afterAll(async () => {
    for (const [name, value] of savedPaywayEnv) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }

    if (prisma === undefined) {
      return;
    }

    // `payments` is RESTRICT, so it goes before `orders`. The line rows go too,
    // because their variant reference is RESTRICT.
    await prisma.payment.deleteMany({
      where: { order: { userId: { in: suiteUsers } } },
    });
    await prisma.orderItem.deleteMany({
      where: { order: { userId: { in: suiteUsers } } },
    });
    await prisma.order.deleteMany({ where: { userId: { in: suiteUsers } } });
    await prisma.inventory.deleteMany({
      where: { variantId: { in: [variantA, variantB] } },
    });
    await prisma.productVariant.deleteMany({
      where: { sku: { startsWith: `admin-status-${run}-` } },
    });
    await prisma.product.deleteMany({
      where: { slug: { startsWith: `admin-status-${run}-` } },
    });
    await prisma.category.deleteMany({ where: { id: categoryId } });
    await prisma.user.deleteMany({
      where: { email: { startsWith: `admin-status-${run}-` } },
    });

    await app.close();
  });

  beforeEach(async () => {
    provider.checkAmount = '0.00';
    await resetStock();
  });

  afterEach(async () => {
    await prisma.payment.deleteMany({
      where: { order: { userId: { in: suiteUsers } } },
    });
    await prisma.orderItem.deleteMany({
      where: { order: { userId: { in: suiteUsers } } },
    });
    await prisma.order.deleteMany({ where: { userId: { in: suiteUsers } } });
  });

  describe('authorisation and validation', () => {
    it.each(['cancel', 'ship'])(
      'rejects an unauthenticated POST %s with 401',
      async (action) => {
        const response = await api(
          'POST',
          `/admin/orders/00000000-0000-4000-8000-000000000000/${action}`,
        );

        expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
      },
    );

    it.each(['cancel', 'ship'])(
      'rejects a customer POST %s with 403',
      async (action) => {
        const order = await createOrder();
        const response = await api(
          'POST',
          `/admin/orders/${order.id}/${action}`,
          { user: customerId },
        );

        expect(response.status).toBe(HttpStatus.FORBIDDEN);
        expect(await orderStatus(order.id)).toBe('PENDING');
      },
    );

    it('rejects a malformed id with 400 before touching the order', async () => {
      const response = await api('POST', '/admin/orders/not-a-uuid/cancel', {
        user: adminId,
      });

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('404s an unknown order for both actions', async () => {
      const unknown = randomUUID();

      expect((await cancel(unknown)).status).toBe(HttpStatus.NOT_FOUND);
      expect((await ship(unknown)).status).toBe(HttpStatus.NOT_FOUND);
    });
  });

  describe('cancellation', () => {
    it('releases a reservation once and rejects a repeat', async () => {
      const order = await createOrder({
        lines: [
          { variantId: variantA, quantity: 2 },
          { variantId: variantB, quantity: 1 },
        ],
      });
      await prisma.inventory.update({
        where: { variantId: variantA },
        data: { reservedQuantity: 2 },
      });
      await prisma.inventory.update({
        where: { variantId: variantB },
        data: { reservedQuantity: 1 },
      });

      const first = await cancel(order.id);

      expect(first.status).toBe(HttpStatus.OK);
      expect(first.body).toMatchObject({
        id: order.id,
        status: 'CANCELLED',
      });
      expect(await orderStatus(order.id)).toBe('CANCELLED');
      expect(await inventoryOf(variantA)).toMatchObject({
        quantity: 100,
        reservedQuantity: 0,
      });
      expect(await inventoryOf(variantB)).toMatchObject({
        quantity: 100,
        reservedQuantity: 0,
      });

      const second = await cancel(order.id);

      expect(second.status).toBe(HttpStatus.CONFLICT);
      expect(await orderStatus(order.id)).toBe('CANCELLED');
      expect(await inventoryOf(variantA)).toMatchObject({
        quantity: 100,
        reservedQuantity: 0,
      });
      expect(await inventoryOf(variantB)).toMatchObject({
        quantity: 100,
        reservedQuantity: 0,
      });
    });

    it('refuses a paid CONFIRMED order and leaves the payment and stock intact', async () => {
      const order = await createOrder({ status: 'CONFIRMED' });
      const payment = await createPayment(order.id, 'PAID', '20.00');
      await prisma.inventory.update({
        where: { variantId: variantA },
        data: { reservedQuantity: 2 },
      });

      const response = await cancel(order.id);

      expect(response.status).toBe(HttpStatus.CONFLICT);
      expect(await orderStatus(order.id)).toBe('CONFIRMED');
      expect(
        (await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }))
          .status,
      ).toBe('PAID');
      expect(await inventoryOf(variantA)).toMatchObject({
        quantity: 100,
        reservedQuantity: 2,
      });
    });

    it('refuses a PENDING order that already has a verified payment', async () => {
      const order = await createOrder();
      await createPayment(order.id, 'PAID', '20.00');
      await prisma.inventory.update({
        where: { variantId: variantA },
        data: { reservedQuantity: 2 },
      });

      const response = await cancel(order.id);

      expect(response.status).toBe(HttpStatus.CONFLICT);
      expect(await orderStatus(order.id)).toBe('PENDING');
      expect(await inventoryOf(variantA)).toMatchObject({
        quantity: 100,
        reservedQuantity: 2,
      });
    });

    it('rolls the status back when the reservation is incoherent', async () => {
      const order = await createOrder({
        lines: [{ variantId: variantA, quantity: 2 }],
      });
      await prisma.inventory.update({
        where: { variantId: variantA },
        data: { reservedQuantity: 1 },
      });

      const response = await cancel(order.id);

      expect(response.status).toBe(HttpStatus.CONFLICT);
      expect(await orderStatus(order.id)).toBe('PENDING');
      expect(await inventoryOf(variantA)).toMatchObject({
        quantity: 100,
        reservedQuantity: 1,
      });
    });

    it('only lets one of two concurrent cancellations release the stock', async () => {
      const order = await createOrder({
        lines: [{ variantId: variantA, quantity: 2 }],
      });
      await prisma.inventory.update({
        where: { variantId: variantA },
        data: { reservedQuantity: 2 },
      });

      const responses = await Promise.all([cancel(order.id), cancel(order.id)]);
      const statuses = responses.map((response) => response.status).sort();

      expect(statuses).toEqual([HttpStatus.OK, HttpStatus.CONFLICT]);
      expect(await orderStatus(order.id)).toBe('CANCELLED');
      expect(await inventoryOf(variantA)).toMatchObject({
        quantity: 100,
        reservedQuantity: 0,
      });
    });
  });

  describe('shipment', () => {
    it('commits a reservation once and rejects a repeat', async () => {
      const order = await createOrder({ status: 'CONFIRMED' });
      await createPayment(order.id, 'PAID', '20.00');
      await prisma.inventory.update({
        where: { variantId: variantA },
        data: { reservedQuantity: 2 },
      });

      const first = await ship(order.id);

      expect(first.status).toBe(HttpStatus.OK);
      expect(first.body).toMatchObject({ id: order.id, status: 'SHIPPED' });
      expect(await orderStatus(order.id)).toBe('SHIPPED');
      expect(await inventoryOf(variantA)).toMatchObject({
        quantity: 98,
        reservedQuantity: 0,
      });

      const second = await ship(order.id);

      expect(second.status).toBe(HttpStatus.CONFLICT);
      expect(await orderStatus(order.id)).toBe('SHIPPED');
      expect(await inventoryOf(variantA)).toMatchObject({
        quantity: 98,
        reservedQuantity: 0,
      });
    });

    it('refuses a CONFIRMED order with no verified payment', async () => {
      const order = await createOrder({ status: 'CONFIRMED' });
      await prisma.inventory.update({
        where: { variantId: variantA },
        data: { reservedQuantity: 2 },
      });

      const response = await ship(order.id);

      expect(response.status).toBe(HttpStatus.CONFLICT);
      expect(await orderStatus(order.id)).toBe('CONFIRMED');
      expect(await inventoryOf(variantA)).toMatchObject({
        quantity: 100,
        reservedQuantity: 2,
      });
    });

    it('refuses an order that is still PENDING even with a paid attempt', async () => {
      const order = await createOrder();
      await createPayment(order.id, 'PAID', '20.00');
      await prisma.inventory.update({
        where: { variantId: variantA },
        data: { reservedQuantity: 2 },
      });

      const response = await ship(order.id);

      expect(response.status).toBe(HttpStatus.CONFLICT);
      expect(await orderStatus(order.id)).toBe('PENDING');
      expect(await inventoryOf(variantA)).toMatchObject({
        quantity: 100,
        reservedQuantity: 2,
      });
    });

    it('rolls the status back when the reservation is incoherent', async () => {
      const order = await createOrder({ status: 'CONFIRMED' });
      await createPayment(order.id, 'PAID', '20.00');
      await prisma.inventory.update({
        where: { variantId: variantA },
        data: { reservedQuantity: 1 },
      });

      const response = await ship(order.id);

      expect(response.status).toBe(HttpStatus.CONFLICT);
      expect(await orderStatus(order.id)).toBe('CONFIRMED');
      expect(await inventoryOf(variantA)).toMatchObject({
        quantity: 100,
        reservedQuantity: 1,
      });
    });

    it('only lets one of two concurrent shipments commit the stock', async () => {
      const order = await createOrder({
        status: 'CONFIRMED',
        lines: [{ variantId: variantA, quantity: 3 }],
      });
      await createPayment(order.id, 'PAID', '30.00');
      await prisma.inventory.update({
        where: { variantId: variantA },
        data: { reservedQuantity: 3 },
      });

      const responses = await Promise.all([ship(order.id), ship(order.id)]);
      const statuses = responses.map((response) => response.status).sort();

      expect(statuses).toEqual([HttpStatus.OK, HttpStatus.CONFLICT]);
      expect(await orderStatus(order.id)).toBe('SHIPPED');
      expect(await inventoryOf(variantA)).toMatchObject({
        quantity: 97,
        reservedQuantity: 0,
      });
    });
  });

  describe('payment interaction', () => {
    it('lets the verified callback confirm an order, then shipment commits its stock', async () => {
      const order = await createOrder();
      const payment = await createPayment(order.id, 'PENDING', '20.00');
      await prisma.inventory.update({
        where: { variantId: variantA },
        data: { reservedQuantity: 2 },
      });
      provider.checkAmount = '20.00';

      const verified = await callback(payment.transactionId);

      expect(verified.status).toBe(HttpStatus.OK);
      expect(await orderStatus(order.id)).toBe('CONFIRMED');
      expect(
        (await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }))
          .status,
      ).toBe('PAID');
      expect(await inventoryOf(variantA)).toMatchObject({
        quantity: 100,
        reservedQuantity: 2,
      });

      const shipped = await ship(order.id);

      expect(shipped.status).toBe(HttpStatus.OK);
      expect(await orderStatus(order.id)).toBe('SHIPPED');
      expect(await inventoryOf(variantA)).toMatchObject({
        quantity: 98,
        reservedQuantity: 0,
      });
    });

    it('cancels a PENDING order with a live attempt without changing that attempt', async () => {
      const order = await createOrder();
      const payment = await createPayment(order.id, 'PENDING', '20.00');
      await prisma.payment.update({
        where: { id: payment.id },
        data: { qrPayload: { qrString: 'secret-qr-payload' } },
      });
      await prisma.inventory.update({
        where: { variantId: variantA },
        data: { reservedQuantity: 2 },
      });

      const response = await cancel(order.id);

      expect(response.status).toBe(HttpStatus.OK);
      expect(JSON.stringify(response.body)).not.toContain('secret-qr-payload');
      expect(JSON.stringify(response.body)).not.toContain('qrPayload');
      expect(await orderStatus(order.id)).toBe('CANCELLED');
      expect(
        (await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }))
          .status,
      ).toBe('PENDING');
      expect(await inventoryOf(variantA)).toMatchObject({
        quantity: 100,
        reservedQuantity: 0,
      });
    });

    /**
     * The documented late-payment hole.
     *
     * There is no server-side expiry job and no refund workflow, so a QR created
     * before cancellation can still be paid afterwards. The provider is the
     * authority on whether money moved, so the callback records `PAID`; the
     * cancelled order cannot be confirmed, and the reservation is not committed a
     * second time. The money needs manual reconciliation.
     */
    it('records a verified late callback after cancellation without moving stock again', async () => {
      const order = await createOrder();
      const payment = await createPayment(order.id, 'PENDING', '20.00');
      await prisma.inventory.update({
        where: { variantId: variantA },
        data: { reservedQuantity: 2 },
      });

      expect((await cancel(order.id)).status).toBe(HttpStatus.OK);
      provider.checkAmount = '20.00';

      const late = await callback(payment.transactionId);

      expect(late.status).toBe(HttpStatus.OK);
      expect(late.body).toMatchObject({ status: 'RECORDED' });
      expect(await orderStatus(order.id)).toBe('CANCELLED');
      expect(
        (await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }))
          .status,
      ).toBe('PAID');
      expect(await inventoryOf(variantA)).toMatchObject({
        quantity: 100,
        reservedQuantity: 0,
      });
    });
  });
});
