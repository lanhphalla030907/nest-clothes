import 'dotenv/config';
import {
  HttpStatus,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { Prisma } from '../src/generated/prisma/client.js';
import { OrderModule } from '../src/orders/order.module.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import {
  bearerHeaders,
  tokenIssuerFor,
  type IssueToken,
} from './support/e2e-auth.js';

/**
 * Customer order cancellation against a **real PostgreSQL** database.
 *
 * The unit suite pins the policy. This file proves the parts the database and
 * real HTTP stack settle: ownership is part of both the read and the guarded
 * write, only a pending unpaid order can move, and exactly one request can release
 * its reservation even when two arrive at once.
 *
 * Every fixture is namespaced by a per-run token and removed in `afterAll`.
 */
describe('Customer order cancellation (PostgreSQL)', () => {
  const run = randomUUID().slice(0, 8);
  const email = (name: string) => `customer-cancel-${run}-${name}@example.test`;
  const slug = (name: string) => `customer-cancel-${run}-${name}`;

  let app: INestApplication;
  let prisma: PrismaService;
  let base: string;
  let issueToken: IssueToken;
  let headers: (id: string) => Record<string, string>;

  let customerId: string;
  let otherCustomerId: string;
  let categoryId: string;
  let variantA: string;
  let variantB: string;

  let orderCounter = 0;
  let paymentCounter = 0;
  const suiteUsers: string[] = [];

  const api = async (
    method: string,
    path: string,
    options: { user?: string | null; body?: unknown } = {},
  ) => {
    const requestHeaders: Record<string, string> = {};

    if (options.user !== null) {
      Object.assign(requestHeaders, headers(options.user ?? customerId));
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

  const cancel = (orderId: string, user: string | null = customerId) =>
    api('POST', `/orders/${orderId}/cancel`, { user });

  const createOrder = async (
    options: {
      ownerId?: string;
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
        userId: options.ownerId ?? customerId,
        orderNumber: `CUST-${run}-${orderCounter}`,
        status: options.status ?? 'PENDING',
        subtotal,
        shippingFee: '0.00',
        discountAmount: '0.00',
        totalAmount: subtotal,
        currency: 'USD',
        shippingRecipientName: 'Customer Cancel Tester',
        shippingPhone: '+15555550100',
        shippingAddressLine1: '18 Mill Lane',
        shippingCity: 'Bristol',
        shippingPostalCode: 'BS1 4TR',
        shippingCountryCode: 'GB',
        items: {
          create: lines.map((line) => ({
            variantId: line.variantId,
            productName: 'Customer Cancel Coat',
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

  const createPayment = (
    orderId: string,
    status: 'PENDING' | 'PAID',
    amount: string,
  ) =>
    prisma.payment.create({
      data: {
        orderId,
        provider: 'ABA_PAYWAY',
        transactionId: `PWC${run}${String((paymentCounter += 1)).padStart(4, '0')}`,
        status,
        amount,
        currency: 'USD',
        paidAt: status === 'PAID' ? new Date() : null,
      },
    });

  const orderStatus = async (orderId: string): Promise<string> =>
    (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status;

  const inventoryOf = (variantId: string) =>
    prisma.inventory.findUniqueOrThrow({ where: { variantId } });

  const reserve = (variantId: string, quantity: number) =>
    prisma.inventory.update({
      where: { variantId },
      data: { reservedQuantity: quantity },
    });

  const resetStock = () =>
    prisma.inventory.updateMany({
      where: { variantId: { in: [variantA, variantB] } },
      data: { quantity: 100, reservedQuantity: 0 },
    });

  const cleanOrders = () =>
    prisma.payment
      .deleteMany({
        where: { order: { userId: { in: suiteUsers } } },
      })
      .then(() =>
        prisma.orderItem.deleteMany({
          where: { order: { userId: { in: suiteUsers } } },
        }),
      )
      .then(() =>
        prisma.order.deleteMany({ where: { userId: { in: suiteUsers } } }),
      );

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        'DATABASE_URL is not set — the customer cancellation integration tests need a real PostgreSQL instance',
      );
    }

    const module: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule, OrderModule],
    }).compile();

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
      data: { name: `Customer Cancel ${run}`, slug: slug('category') },
    });
    categoryId = category.id;

    const createUser = async (name: string) =>
      (
        await prisma.user.create({
          data: {
            firstName: 'Customer',
            lastName: 'Tester',
            email: email(name),
            passwordHash: 'argon2-not-a-real-hash',
            status: 'ACTIVE',
          },
        })
      ).id;

    customerId = await createUser('owner');
    otherCustomerId = await createUser('other');
    suiteUsers.push(customerId, otherCustomerId);

    const product = await prisma.product.create({
      data: {
        categoryId,
        name: 'Customer Cancel Coat',
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
    if (prisma === undefined) {
      return;
    }

    await cleanOrders();
    await prisma.inventory.deleteMany({
      where: { variantId: { in: [variantA, variantB] } },
    });
    await prisma.productVariant.deleteMany({
      where: { sku: { startsWith: `customer-cancel-${run}-` } },
    });
    await prisma.product.deleteMany({
      where: { slug: { startsWith: `customer-cancel-${run}-` } },
    });
    await prisma.category.deleteMany({ where: { id: categoryId } });
    await prisma.user.deleteMany({
      where: { email: { startsWith: `customer-cancel-${run}-` } },
    });

    await app.close();
  });

  beforeEach(async () => {
    await resetStock();
  });

  afterEach(async () => {
    await cleanOrders();
  });

  describe('authorisation and validation', () => {
    it('rejects an unauthenticated request with 401', async () => {
      const order = await createOrder();

      const response = await cancel(order.id, null);

      expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
      expect(await orderStatus(order.id)).toBe('PENDING');
    });

    it('rejects a malformed order id before the service', async () => {
      const response = await cancel('not-a-uuid');

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('404s an unknown order', async () => {
      const response = await cancel(randomUUID());

      expect(response.status).toBe(HttpStatus.NOT_FOUND);
    });

    it('404s another customer\'s order and leaves it untouched', async () => {
      const order = await createOrder();
      await reserve(variantA, 2);

      const response = await cancel(order.id, otherCustomerId);

      expect(response.status).toBe(HttpStatus.NOT_FOUND);
      expect(await orderStatus(order.id)).toBe('PENDING');
      expect(await inventoryOf(variantA)).toMatchObject({
        quantity: 100,
        reservedQuantity: 2,
      });
    });
  });

  describe('cancellation', () => {
    it('cancels the caller\'s pending unpaid order and releases every reservation once', async () => {
      const order = await createOrder({
        lines: [
          { variantId: variantA, quantity: 2 },
          { variantId: variantB, quantity: 1 },
        ],
      });
      await reserve(variantA, 2);
      await reserve(variantB, 1);

      const first = await cancel(order.id);

      expect(first.status).toBe(HttpStatus.OK);
      expect(first.body).toMatchObject({
        id: order.id,
        userId: customerId,
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

    it('refuses a PENDING order that already has a verified payment', async () => {
      const order = await createOrder();
      await createPayment(order.id, 'PAID', '20.00');
      await reserve(variantA, 2);

      const response = await cancel(order.id);

      expect(response.status).toBe(HttpStatus.CONFLICT);
      expect(await orderStatus(order.id)).toBe('PENDING');
      expect(await inventoryOf(variantA)).toMatchObject({
        quantity: 100,
        reservedQuantity: 2,
      });
    });

    it.each(['CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED'])(
      'refuses an order in %s without releasing stock',
      async (status) => {
        const order = await createOrder({ status });
        await reserve(variantA, 2);

        const response = await cancel(order.id);

        expect(response.status).toBe(HttpStatus.CONFLICT);
        expect(await orderStatus(order.id)).toBe(status);
        expect(await inventoryOf(variantA)).toMatchObject({
          quantity: 100,
          reservedQuantity: 2,
        });
      },
    );

    it('only lets one of two concurrent cancellations release the stock', async () => {
      const order = await createOrder({
        lines: [{ variantId: variantA, quantity: 2 }],
      });
      await reserve(variantA, 2);

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
});
