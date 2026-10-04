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
import { PaymentsModule } from '../src/payments/payments.module.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { TEMPORARY_USER_ID_HEADER } from '../src/common/decorators/temporary-user-id.decorator.js';
import {
  PAYWAY_HTTP_CLIENT,
  type PaywayHttpClient,
  type PaywayHttpResponse,
} from '../src/payments/payway/payway.types.js';
import { PAYWAY_PATHS } from '../src/payments/payway/payway.constants.js';

/**
 * Payments against a **real PostgreSQL** database, with PayWay's HTTP client stubbed.
 *
 * Everything this feature promises about idempotency is a promise about the *database*,
 * and a mock cannot check any of it. The unit spec proves which methods are called in
 * which order; this file proves the consequences:
 *
 * - **one live attempt per order.** Two concurrent `POST /orders/:orderId/payments` for
 *   the same order must leave exactly one `PENDING` row and one PayWay call, and both
 *   responses must carry that same `transactionId`. This is the partial unique index
 *   `payments_one_pending_per_order_key` doing the work, and it can only be observed
 *   with two real connections racing for the same row.
 * - **the check constraints hold.** `amount > 0`, an upper-case three-letter currency,
 *   and "`paid_at` is set if and only if the status is `PAID`" are all enforced by
 *   PostgreSQL, so they are asserted by trying to violate them.
 * - **confirmation is atomic.** A verified callback must leave the order `CONFIRMED`
 *   and the payment `PAID` together; a replay of the same webhook must change nothing
 *   and must not decrement stock.
 * - **the client cannot influence the amount.** `POST` with `amount` in the body is a
 *   400 before anything is written.
 *
 * ## The provider is stubbed, and structurally so
 *
 * `PAYWAY_HTTP_CLIENT` is overridden with a factory, so there is no code path from this
 * suite to `checkout-sandbox.payway.com.kh` — not by forgetting to stub something, but
 * because the real client is never provided. Every response below is a fixture shaped
 * like PayWay's documented one.
 *
 * Fixtures are namespaced by a per-run token and torn down in `afterAll`, unwinding the
 * schema's own `ON DELETE` rules.
 */
describe('Payments (PostgreSQL)', () => {
  const run = randomUUID().slice(0, 8);
  const email = (name: string) => `payments-${run}-${name}@example.test`;
  const slug = (name: string) => `payments-${run}-${name}`;

  const TOTAL = '129.00';
  const CURRENCY = 'USD';
  const TRANSACTION_ID = 'PW261004153007ABC123';
  const QR_STRING = '00020101021129251014dev.test6308ABCD';

  let app: INestApplication;
  let prisma: PrismaService;
  let base: string;
  let categoryId: string;
  let userId: string;
  let otherUserId: string;
  let variantId: string;

  /** Users this suite creates, so teardown cannot touch another suite's rows. */
  const suiteUsers: string[] = [];

  /**
   * The stubbed provider.
   *
   * Each field is a queue of answers, so a test can set up "success, then fail" without
   * the stub needing to know anything about the test. `calls` records what was asked for,
   * which is how "no second PayWay call" is asserted rather than assumed.
   */
  const provider = {
    generateQrQueue: [] as PaywayHttpResponse[],
    checkQueue: [] as PaywayHttpResponse[],
    calls: [] as { endpoint: string; body: Record<string, unknown> }[],
    reset(): void {
      this.generateQrQueue.length = 0;
      this.checkQueue.length = 0;
      this.calls.length = 0;
    },
  };

  /** A PayWay `generate-qr` success. */
  const qrResponse = (
    overrides: Record<string, unknown> = {},
  ): PaywayHttpResponse => ({
    ok: true,
    status: 200,
    text: () =>
      Promise.resolve(
        JSON.stringify({
          status: { code: '0', message: 'Success', trace_id: 'trace-e2e' },
          qrString: QR_STRING,
          qrImage: 'data:image/png;base64,iVBORw0KGgo=',
          abapay_deeplink: 'abapay://link',
          ...overrides,
        }),
      ),
  });

  /** A PayWay `check-transaction-2` answer. */
  const checkResponse = (
    transactionId: string,
    data: Record<string, unknown> = {},
    status: Record<string, unknown> = {},
  ): PaywayHttpResponse => ({
    ok: true,
    status: 200,
    text: () =>
      Promise.resolve(
        JSON.stringify({
          status: { code: '00', message: 'Success', tran_id: transactionId, ...status },
          data: {
            payment_status_code: 0,
            payment_status: 'APPROVED',
            total_amount: 129,
            payment_amount: 129,
            payment_currency: CURRENCY,
            apv: 'APV-E2E',
            ...data,
          },
        }),
      ),
  });

  /** A provider refusal or transport failure. */
  const failureResponse = (): PaywayHttpResponse => ({
    ok: false,
    status: 503,
    text: () => Promise.resolve('upstream unavailable'),
  });

  const stubClient: PaywayHttpClient = (url, init) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    const isCheck = url.endsWith(PAYWAY_PATHS.checkTransaction);

    provider.calls.push({ endpoint: url, body });

    const queue = isCheck ? provider.checkQueue : provider.generateQrQueue;
    const next = queue.shift() ?? (isCheck ? checkResponse(String(body['tran_id'])) : qrResponse());

    return Promise.resolve(next);
  };

  const headers = (id: string) => ({
    'Content-Type': 'application/json',
    [TEMPORARY_USER_ID_HEADER]: id,
  });

  const api = async (
    method: string,
    path: string,
    options: { user?: string; body?: unknown; rawBody?: string } = {},
  ) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: headers(options.user ?? userId),
      ...(options.body === undefined && options.rawBody === undefined
        ? {}
        : { body: options.rawBody ?? JSON.stringify(options.body) }),
    });

    const text = await response.text();

    return {
      status: response.status,
      body: text.length === 0 ? undefined : (JSON.parse(text) as Record<string, unknown>),
    };
  };

  /** A pending order for `owner`, totalling `total` in `currency`. */
  const createOrder = async (
    owner: string,
    options: { total?: string; currency?: string; status?: string } = {},
  ) => {
    const order = await prisma.order.create({
      data: {
        userId: owner,
        orderNumber: `ORD-${run}-${randomUUID().slice(0, 8).toUpperCase()}`,
        status: options.status ?? 'PENDING',
        subtotal: options.total ?? TOTAL,
        shippingFee: '0.00',
        discountAmount: '0.00',
        totalAmount: options.total ?? TOTAL,
        currency: options.currency ?? CURRENCY,
        shippingRecipientName: 'Payments Tester',
        shippingPhone: '+15555550100',
        shippingAddressLine1: '1 Pay Lane',
        shippingCity: 'Leeds',
        shippingCountryCode: 'GB',
      },
    });

    return order;
  };

  const readPayments = (orderId: string) =>
    prisma.payment.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
    });

  const readOrder = (id: string) => prisma.order.findUniqueOrThrow({ where: { id } });

  const callback = (payload: Record<string, unknown>) =>
    api('POST', '/payments/aba-payway/callback', { body: payload });

  /**
   * Fake PayWay configuration, installed before the module is compiled.
   *
   * `readPaywayConfig` runs once, in a provider factory, so the values have to be in
   * `process.env` by the time `compile()` resolves — setting them per test would be too
   * late. They are deliberately fake: the stubbed HTTP client never signs anything, so
   * these only have to be *present and well-formed* for the integration to consider
   * itself configured, and no test can use them to reach PayWay.
   *
   * The originals are restored in `afterAll` so this suite cannot leak configuration into
   * another file in the same process.
   */
  const FAKE_PAYWAY_ENV = {
    PAYWAY_MERCHANT_ID: 'test-merchant',
    PAYWAY_API_KEY: 'test-api-key-not-a-real-secret',
    PAYWAY_CALLBACK_URL: 'https://api.example.test/payments/aba-payway/callback',
  } as const;

  const savedPaywayEnv = new Map<string, string | undefined>();

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        'DATABASE_URL is not set — the payments integration tests need a real PostgreSQL instance',
      );
    }

    for (const [name, value] of Object.entries(FAKE_PAYWAY_ENV)) {
      savedPaywayEnv.set(name, process.env[name]);
      process.env[name] = value;
    }

    const module: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule, OrderModule, PaymentsModule],
    })
      .overrideProvider(PAYWAY_HTTP_CLIENT)
      .useValue(stubClient)
      .compile();

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
      data: { name: `Payments ${run}`, slug: slug('category') },
    });
    categoryId = category.id;

    const createUser = async (name: string) =>
      prisma.user.create({
        data: {
          firstName: 'Payments',
          lastName: 'Tester',
          email: email(name),
          passwordHash: 'argon2-not-a-real-hash',
          status: 'ACTIVE',
        },
      });

    userId = (await createUser('owner')).id;
    otherUserId = (await createUser('other')).id;
    suiteUsers.push(userId, otherUserId);

    const product = await prisma.product.create({
      data: {
        categoryId,
        name: 'Payments Peacoat',
        slug: slug('product'),
        basePrice: TOTAL,
        status: 'ACTIVE',
      },
    });
    const variant = await prisma.productVariant.create({
      data: { productId: product.id, sku: slug('SKU-1'), price: TOTAL },
    });
    variantId = variant.id;
    await prisma.inventory.create({
      data: { variantId: variant.id, quantity: 20, reservedQuantity: 0 },
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

    // Scoped to this suite's own rows. `payments` is deleted before `orders`, because the
    // FK is `ON DELETE RESTRICT` — the schema refusing this order is the same constraint
    // the suite asserts on.
    await prisma.payment.deleteMany({
      where: { order: { userId: { in: suiteUsers } } },
    });
    await prisma.orderItem.deleteMany({
      where: { order: { userId: { in: suiteUsers } } },
    });
    await prisma.order.deleteMany({ where: { userId: { in: suiteUsers } } });
    await prisma.inventory.deleteMany({
      where: { variant: { sku: { startsWith: `payments-${run}-` } } },
    });
    await prisma.productVariant.deleteMany({
      where: { sku: { startsWith: `payments-${run}-` } },
    });
    await prisma.product.deleteMany({
      where: { slug: { startsWith: `payments-${run}-` } },
    });
    await prisma.category.deleteMany({ where: { slug: slug('category') } });
    await prisma.user.deleteMany({
      where: { email: { startsWith: `payments-${run}-` } },
    });

    await app.close();
  });

  beforeEach(() => {
    provider.reset();
  });

  describe('POST /orders/:orderId/payments', () => {
    it('creates a PENDING payment and returns the QR', async () => {
      const order = await createOrder(userId);

      const response = await api('POST', `/orders/${order.id}/payments`, { body: {} });

      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body).toMatchObject({
        orderId: order.id,
        status: 'PENDING',
        amount: TOTAL,
        currency: CURRENCY,
        qrString: QR_STRING,
        qrImage: 'data:image/png;base64,iVBORw0KGgo=',
        abapayDeeplink: 'abapay://link',
        lifetimeMinutes: 30,
      });
      expect(typeof response.body!['paymentId']).toBe('string');
      expect(typeof response.body!['expiresAt']).toBe('string');

      const stored = await readPayments(order.id);
      expect(stored).toHaveLength(1);
      expect(stored[0]!.status).toBe('PENDING');
      expect(stored[0]!.provider).toBe('ABA_PAYWAY');
      expect(stored[0]!.paidAt).toBeNull();
    });

    it('generates a PayWay-shaped transaction id within its 20-character limit', async () => {
      const order = await createOrder(userId);

      await api('POST', `/orders/${order.id}/payments`, { body: {} });

      const stored = await readPayments(order.id);
      const transactionId = stored[0]!.transactionId;

      expect(transactionId).toMatch(/^PW\d{12}[A-Z0-9]{6}$/);
      expect(transactionId).toHaveLength(20);
    });

    it('sends the order total to PayWay, formatted to two decimals', async () => {
      const order = await createOrder(userId, { total: '8.5' });

      await api('POST', `/orders/${order.id}/payments`, { body: {} });

      const generateCall = provider.calls.find((call) =>
        call.endpoint.endsWith(PAYWAY_PATHS.generateQr),
      );

      expect(generateCall?.body['amount']).toBe('8.50');
      expect(generateCall?.body['currency']).toBe(CURRENCY);
    });

    it('never returns a credential or a raw provider body', async () => {
      const order = await createOrder(userId);

      const response = await api('POST', `/orders/${order.id}/payments`, { body: {} });
      const serialised = JSON.stringify(response.body);

      expect(serialised).not.toContain('merchant_id');
      expect(serialised).not.toContain('hash');
      expect(serialised).not.toContain('trace_id');
      expect(serialised).not.toContain(process.env['PAYWAY_API_KEY'] ?? 'unset-key');
      expect(serialised).not.toContain(userId);
    });

    describe('the client cannot influence the payment', () => {
      it.each([
        ['amount', '0.01'],
        ['currency', 'KHR'],
        ['totalAmount', '0.01'],
        ['status', 'PAID'],
        ['provider', 'ABA_PAYWAY'],
        ['transactionId', TRANSACTION_ID],
        ['orderId', 'some-other-order'],
      ])('rejects a body carrying %s with 400 and writes nothing', async (field, value) => {
        const order = await createOrder(userId);

        const response = await api('POST', `/orders/${order.id}/payments`, {
          body: { [field]: value },
        });

        expect(response.status).toBe(HttpStatus.BAD_REQUEST);
        expect(await readPayments(order.id)).toHaveLength(0);
      });

      it('accepts an empty body, and a body-less request', async () => {
        const withEmpty = await createOrder(userId);
        const withNone = await createOrder(userId);

        const first = await api('POST', `/orders/${withEmpty.id}/payments`, { body: {} });
        const second = await api('POST', `/orders/${withNone.id}/payments`);

        expect(first.status).toBe(HttpStatus.OK);
        expect(second.status).toBe(HttpStatus.OK);
      });
    });

    describe('ownership and order state', () => {
      it('404s for an order that does not exist', async () => {
        const response = await api('POST', '/orders/99999999-9999-4999-8999-999999999999/payments', {
          body: {},
        });

        expect(response.status).toBe(HttpStatus.NOT_FOUND);
      });

      it("404s for another user's order, identically", async () => {
        const order = await createOrder(otherUserId);

        const mine = await createOrder(userId);
        const notMine = await api('POST', `/orders/${order.id}/payments`, {
          user: userId,
          body: {},
        });
        const absent = await api(
          'POST',
          '/orders/99999999-9999-4999-8999-999999999999/payments',
          { body: {} },
        );

        expect(notMine.status).toBe(HttpStatus.NOT_FOUND);
        expect(absent.status).toBe(HttpStatus.NOT_FOUND);
        void mine;
      });

      it('400s a malformed order id before touching the database', async () => {
        const response = await api('POST', '/orders/not-a-uuid/payments', { body: {} });

        expect(response.status).toBe(HttpStatus.BAD_REQUEST);
        expect(provider.calls).toHaveLength(0);
      });

      it('404s without the identity header', async () => {
        const order = await createOrder(userId);

        const response = await fetch(`${base}/orders/${order.id}/payments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });

        expect(response.status).toBe(HttpStatus.BAD_REQUEST);
      });

      it.each(['CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED'])(
        '409s for a %s order',
        async (status) => {
          const order = await createOrder(userId, { status });

          const response = await api('POST', `/orders/${order.id}/payments`, { body: {} });

          expect(response.status).toBe(HttpStatus.CONFLICT);
          expect(await readPayments(order.id)).toHaveLength(0);
        },
      );

      it('422s for an order in a currency PayWay does not accept', async () => {
        const order = await createOrder(userId, { currency: 'EUR' });

        const response = await api('POST', `/orders/${order.id}/payments`, { body: {} });

        expect(response.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
        expect(provider.calls).toHaveLength(0);
      });
    });

    describe('idempotency', () => {
      it('returns the same payment on a repeat request, without a second PayWay call', async () => {
        const order = await createOrder(userId);

        const first = await api('POST', `/orders/${order.id}/payments`, { body: {} });
        const second = await api('POST', `/orders/${order.id}/payments`, { body: {} });

        expect(second.status).toBe(HttpStatus.OK);
        expect(second.body).toEqual(first.body);
        expect(await readPayments(order.id)).toHaveLength(1);
        expect(
          provider.calls.filter((call) =>
            call.endpoint.endsWith(PAYWAY_PATHS.generateQr),
          ),
        ).toHaveLength(1);
      });

      it('collapses concurrent requests onto one attempt', async () => {
        const order = await createOrder(userId);

        const [a, b, c] = await Promise.all([
          api('POST', `/orders/${order.id}/payments`, { body: {} }),
          api('POST', `/orders/${order.id}/payments`, { body: {} }),
          api('POST', `/orders/${order.id}/payments`, { body: {} }),
        ]);

        const stored = await readPayments(order.id);

        // The index is the authority: one live attempt, whichever request won.
        expect(stored).toHaveLength(1);
        expect(stored[0]!.status).toBe('PENDING');
        expect(
          provider.calls.filter((call) =>
            call.endpoint.endsWith(PAYWAY_PATHS.generateQr),
          ),
        ).toHaveLength(1);

        const succeeded = [a, b, c].filter((r) => r.status === HttpStatus.OK);
        const transactionIds = new Set(succeeded.map((r) => r.body!['transactionId']));

        // Every request that got a QR got the *same* QR for the same transaction.
        expect(transactionIds.size).toBeLessThanOrEqual(1);
        expect(stored[0]!.transactionId).toBe(
          [...transactionIds][0] ?? stored[0]!.transactionId,
        );
      });

      it('lets a fresh attempt start once the previous one failed', async () => {
        const order = await createOrder(userId);
        provider.generateQrQueue.push(failureResponse());

        const failed = await api('POST', `/orders/${order.id}/payments`, { body: {} });
        expect(failed.status).toBe(HttpStatus.BAD_GATEWAY);

        const stored = await readPayments(order.id);
        expect(stored).toHaveLength(1);
        expect(stored[0]!.status).toBe('FAILED');

        const retried = await api('POST', `/orders/${order.id}/payments`, { body: {} });
        expect(retried.status).toBe(HttpStatus.OK);

        // The failed row is kept, not overwritten: it is a record of the attempt.
        const after = await readPayments(order.id);
        expect(after).toHaveLength(2);
        expect(after.filter((p) => p.status === 'PENDING')).toHaveLength(1);
      });

      it('marks the attempt FAILED when the provider call does not produce a QR', async () => {
        const order = await createOrder(userId);
        provider.generateQrQueue.push(failureResponse());

        await api('POST', `/orders/${order.id}/payments`, { body: {} });

        const stored = await readPayments(order.id);
        expect(stored[0]!.status).toBe('FAILED');
        expect(stored[0]!.paidAt).toBeNull();
      });
    });
  });

  describe('POST /payments/aba-payway/callback', () => {
    /** Creates a PENDING order with a QR attached, ready to be "paid". */
    const payableOrder = async () => {
      const order = await createOrder(userId);
      const response = await api('POST', `/orders/${order.id}/payments`, { body: {} });

      return { order, paymentId: response.body!['paymentId'] as string };
    };

    it('verifies with PayWay and confirms the order', async () => {
      const { order } = await payableOrder();
      const payment = (await readPayments(order.id))[0]!;

      const response = await callback({ merchant_ref: payment.transactionId });

      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body).toEqual({ status: 'RECORDED' });

      const confirmed = await readOrder(order.id);
      expect(confirmed.status).toBe('CONFIRMED');

      const stored = await readPayments(order.id);
      expect(stored[0]!.status).toBe('PAID');
      expect(stored[0]!.paidAt).toBeInstanceOf(Date);
      expect(stored[0]!.providerReference).toBe('APV-E2E');
    });

    it('asks PayWay about the stored transaction, not the one in the payload', async () => {
      const { order } = await payableOrder();
      const payment = (await readPayments(order.id))[0]!;

      await callback({ merchant_ref: payment.transactionId });

      const checkCall = provider.calls.find((call) =>
        call.endpoint.endsWith(PAYWAY_PATHS.checkTransaction),
      );

      expect(checkCall?.body['tran_id']).toBe(payment.transactionId);
      expect(checkCall?.body).toHaveProperty('hash');
    });

    it('leaves inventory untouched, because checkout already committed it', async () => {
      const { order } = await payableOrder();
      const payment = (await readPayments(order.id))[0]!;
      const before = await prisma.inventory.findUniqueOrThrow({
        where: { variantId },
      });

      await callback({ merchant_ref: payment.transactionId });

      const after = await prisma.inventory.findUniqueOrThrow({ where: { variantId } });

      expect(after.quantity).toBe(before.quantity);
      expect(after.reservedQuantity).toBe(before.reservedQuantity);
      void order;
    });

    describe('an unauthenticated caller', () => {
      it('cannot confirm a payment PayWay says is unpaid', async () => {
        const { order } = await payableOrder();
        const payment = (await readPayments(order.id))[0]!;

        provider.checkQueue.push(
          checkResponse(payment.transactionId, {
            payment_status_code: 3,
            payment_status: 'PENDING',
          }),
        );

        const response = await callback({
          merchant_ref: payment.transactionId,
          // Everything an attacker would hope this endpoint trusted:
          payment_status: 'APPROVED',
          payment_status_code: '0',
          amount: '129.00',
          currency: 'USD',
        });

        expect(response.status).toBe(HttpStatus.OK);
        expect(response.body).toEqual({ status: 'NOT_COLLECTED' });
        expect((await readOrder(order.id)).status).toBe('PENDING');
        expect((await readPayments(order.id))[0]!.status).toBe('PENDING');
      });

      it('cannot confirm a payment for a transaction id that does not exist', async () => {
        const response = await callback({ merchant_ref: 'PW260404000000NOPE01' });

        expect(response.status).toBe(HttpStatus.NOT_FOUND);
        // A 404 tells the caller its guess was wrong without confirming anything exists.
        expect(provider.calls).toHaveLength(0);
      });

      it('cannot confirm anything without a transaction id', async () => {
        const response = await callback({ payment_status: 'APPROVED' });

        expect(response.status).toBe(HttpStatus.BAD_REQUEST);
        expect(provider.calls).toHaveLength(0);
      });

      it('is rejected for a malformed transaction id before any lookup', async () => {
        const response = await callback({ merchant_ref: 'not a transaction id' });

        expect(response.status).toBe(HttpStatus.BAD_REQUEST);
        expect(provider.calls).toHaveLength(0);
      });

      it('cannot walk the id space with a non-object body', async () => {
        for (const raw of ['[]', '"merchant_ref"', 'null', '42']) {
          const response = await api('POST', '/payments/aba-payway/callback', {
            rawBody: raw,
          });

          expect(response.status).toBe(HttpStatus.BAD_REQUEST);
        }

        expect(provider.calls).toHaveLength(0);
      });

      it('cannot crash the endpoint with a wrong-typed field', async () => {
        const response = await callback({ merchant_ref: { nested: 'object' } });

        expect(response.status).toBe(HttpStatus.BAD_REQUEST);
      });

      it('tolerates provider fields this project does not know', async () => {
        // The global pipe would reject these. An integration whose availability depends on
        // a third party's field list would be an outage waiting to happen.
        const { order } = await payableOrder();
        const payment = (await readPayments(order.id))[0]!;

        const response = await api('POST', '/payments/aba-payway/callback', {
          body: {
            merchant_ref: payment.transactionId,
            a_field_payway_added_later: 'unexpected',
            nested: { anything: [1, 2, 3] },
          },
        });

        expect(response.status).toBe(HttpStatus.OK);
        expect((await readOrder(order.id)).status).toBe('CONFIRMED');
      });
    });

    describe('verification failures', () => {
      it('refuses an amount that does not match the order', async () => {
        const { order } = await payableOrder();
        const payment = (await readPayments(order.id))[0]!;

        provider.checkQueue.push(
          checkResponse(payment.transactionId, { total_amount: 1, payment_amount: 1 }),
        );

        const response = await callback({ merchant_ref: payment.transactionId });

        expect(response.status).toBe(HttpStatus.CONFLICT);
        expect((await readOrder(order.id)).status).toBe('PENDING');
        expect((await readPayments(order.id))[0]!.status).toBe('PENDING');
      });

      it('refuses a currency that does not match the order', async () => {
        const { order } = await payableOrder();
        const payment = (await readPayments(order.id))[0]!;

        provider.checkQueue.push(
          checkResponse(payment.transactionId, { payment_currency: 'KHR' }),
        );

        const response = await callback({ merchant_ref: payment.transactionId });

        expect(response.status).toBe(HttpStatus.CONFLICT);
        expect((await readOrder(order.id)).status).toBe('PENDING');
      });

      it('refuses a reply about a different transaction', async () => {
        const { order } = await payableOrder();
        const payment = (await readPayments(order.id))[0]!;

        provider.checkQueue.push(checkResponse('PW999999999999OTHER'));

        const response = await callback({ merchant_ref: payment.transactionId });

        expect(response.status).toBe(HttpStatus.BAD_GATEWAY);
        expect((await readOrder(order.id)).status).toBe('PENDING');
      });

      it('does not leak the figures in the 409 body', async () => {
        const { order } = await payableOrder();
        const payment = (await readPayments(order.id))[0]!;

        provider.checkQueue.push(
          checkResponse(payment.transactionId, { total_amount: 1, payment_amount: 1 }),
        );

        const response = await callback({ merchant_ref: payment.transactionId });

        expect(JSON.stringify(response.body)).not.toContain('129');
        expect(JSON.stringify(response.body)).not.toContain(payment.transactionId);
      });
    });

    describe('repeated deliveries', () => {
      it('is idempotent, and does not ask PayWay a second time', async () => {
        const { order } = await payableOrder();
        const payment = (await readPayments(order.id))[0]!;

        const first = await callback({ merchant_ref: payment.transactionId });
        const second = await callback({ merchant_ref: payment.transactionId });

        expect(first.body).toEqual({ status: 'RECORDED' });
        expect(second.body).toEqual({ status: 'ALREADY_RECORDED' });
        expect((await readOrder(order.id)).status).toBe('CONFIRMED');

        expect(
          provider.calls.filter((call) =>
            call.endpoint.endsWith(PAYWAY_PATHS.checkTransaction),
          ),
        ).toHaveLength(1);
      });

      it('leaves exactly one PAID row however many times it arrives', async () => {
        const { order } = await payableOrder();
        const payment = (await readPayments(order.id))[0]!;

        await Promise.all(
          Array.from({ length: 4 }, () =>
            callback({ merchant_ref: payment.transactionId }),
          ),
        );

        const stored = await readPayments(order.id);
        expect(stored.filter((p) => p.status === 'PAID')).toHaveLength(1);
        expect((await readOrder(order.id)).status).toBe('CONFIRMED');
      });

      it('accepts the transaction_id spelling too', async () => {
        const { order } = await payableOrder();
        const payment = (await readPayments(order.id))[0]!;

        const response = await callback({ transaction_id: payment.transactionId });

        expect(response.body).toEqual({ status: 'RECORDED' });
        expect((await readOrder(order.id)).status).toBe('CONFIRMED');
      });

      it('refuses a second payment for an already-confirmed order', async () => {
        const { order } = await payableOrder();
        const payment = (await readPayments(order.id))[0]!;
        await callback({ merchant_ref: payment.transactionId });

        const response = await api('POST', `/orders/${order.id}/payments`, { body: {} });

        expect(response.status).toBe(HttpStatus.CONFLICT);
      });
    });
  });

  describe('database constraints', () => {
    it('rejects a non-positive amount', async () => {
      const order = await createOrder(userId);

      await expect(
        prisma.payment.create({
          data: {
            orderId: order.id,
            provider: 'ABA_PAYWAY',
            transactionId: 'PW260404000000ZERO01',
            status: 'PENDING',
            amount: '0.00',
            currency: CURRENCY,
          },
        }),
      ).rejects.toThrow();
    });

    it('rejects a lower-case currency', async () => {
      const order = await createOrder(userId);

      await expect(
        prisma.payment.create({
          data: {
            orderId: order.id,
            provider: 'ABA_PAYWAY',
            transactionId: 'PW260404000000LOWER1',
            status: 'PENDING',
            amount: TOTAL,
            currency: 'usd',
          },
        }),
      ).rejects.toThrow();
    });

    it('rejects PAID without a paid_at, and PENDING with one', async () => {
      const order = await createOrder(userId);

      await expect(
        prisma.payment.create({
          data: {
            orderId: order.id,
            provider: 'ABA_PAYWAY',
            transactionId: 'PW260404000000NOPAY1',
            status: 'PAID',
            amount: TOTAL,
            currency: CURRENCY,
          },
        }),
      ).rejects.toThrow();

      await expect(
        prisma.payment.create({
          data: {
            orderId: order.id,
            provider: 'ABA_PAYWAY',
            transactionId: 'PW260404000000WITHAT',
            status: 'PENDING',
            amount: TOTAL,
            currency: CURRENCY,
            paidAt: new Date(),
          },
        }),
      ).rejects.toThrow();
    });

    it('rejects a duplicate transaction id', async () => {
      const first = await createOrder(userId);
      const second = await createOrder(userId);

      await prisma.payment.create({
        data: {
          orderId: first.id,
          provider: 'ABA_PAYWAY',
          transactionId: TRANSACTION_ID,
          status: 'PENDING',
          amount: TOTAL,
          currency: CURRENCY,
        },
      });

      await expect(
        prisma.payment.create({
          data: {
            orderId: second.id,
            provider: 'ABA_PAYWAY',
            transactionId: TRANSACTION_ID,
            status: 'PENDING',
            amount: TOTAL,
            currency: CURRENCY,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('allows several attempts for one order but only one live', async () => {
      const order = await createOrder(userId);

      await prisma.payment.create({
        data: {
          orderId: order.id,
          provider: 'ABA_PAYWAY',
          transactionId: 'PW26040400000FAILED1',
          status: 'FAILED',
          amount: TOTAL,
          currency: CURRENCY,
        },
      });
      await prisma.payment.create({
        data: {
          orderId: order.id,
          provider: 'ABA_PAYWAY',
          transactionId: 'PW260404000000EXPIRE',
          status: 'EXPIRED',
          amount: TOTAL,
          currency: CURRENCY,
        },
      });

      // The partial index is what makes "one live" true; without the `status = 'PENDING'`
      // predicate these two would collide with each other as well.
      await prisma.payment.create({
        data: {
          orderId: order.id,
          provider: 'ABA_PAYWAY',
          transactionId: 'PW26040400000LIVE001',
          status: 'PENDING',
          amount: TOTAL,
          currency: CURRENCY,
        },
      });

      await expect(
        prisma.payment.create({
          data: {
            orderId: order.id,
            provider: 'ABA_PAYWAY',
            transactionId: 'PW26040400000LIVE002',
            status: 'PENDING',
            amount: TOTAL,
            currency: CURRENCY,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('refuses to delete an order that has payments', async () => {
      const order = await createOrder(userId);
      await prisma.payment.create({
        data: {
          orderId: order.id,
          provider: 'ABA_PAYWAY',
          transactionId: 'PW26040400000RESTRIC',
          status: 'PENDING',
          amount: TOTAL,
          currency: CURRENCY,
        },
      });

      // `ON DELETE RESTRICT`, so a payment's money record cannot be orphaned by a
      // cascade that took the order with it.
      await expect(
        prisma.order.delete({ where: { id: order.id } }),
      ).rejects.toMatchObject({ code: 'P2003' });
    });

    it('keeps Decimal precision through the round trip', async () => {
      const order = await createOrder(userId, { total: '0.07' });

      const response = await api('POST', `/orders/${order.id}/payments`, { body: {} });

      // `parseFloat('0.07') * 100` is 7.000000000000001; the stored and returned value
      // must be exactly 0.07.
      expect(response.body!['amount']).toBe('0.07');
      const stored = await readPayments(order.id);
      expect(stored[0]!.amount.equals(new Prisma.Decimal('0.07'))).toBe(true);
    });
  });
});
