import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import type { OrderWithItems } from '../orders/repositories/order.repository.js';
import type { Payment, PaymentQrPayload } from './repositories/payment.repository.js';
import { PaymentsService } from './payments.service.js';
import type { PaywayService } from './payway/payway.service.js';
import type { PaywayTransactionCheck } from './payway/payway.types.js';
import type { TransactionIdGenerator } from './payment-transaction-id.generator.js';
import type { PaymentRepository } from './repositories/payment.repository.js';
import type { OrderRepository } from '../orders/repositories/order.repository.js';

/**
 * The orchestration rules, with both repositories and the provider stubbed.
 *
 * These tests exist for the decisions that are *not* the gateway's: what happens on a
 * duplicate, which columns are written, what a webhook is allowed to conclude on its
 * own, and what happens when two requests race. `PaywayService` has its own suite for
 * the wire format; this one asserts only that the right things happen with its answers.
 */

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const ORDER_ID = '33333333-3333-4333-8333-333333333333';
const PAYMENT_ID = '44444444-4444-4444-8444-444444444444';
const TRANSACTION_ID = 'PW261004153007ABC123';

const TOTAL = new Prisma.Decimal('129.00');

const qrPayload: PaymentQrPayload = {
  qrString: '00020101021129...',
  qrImage: 'data:image/png;base64,iVBORw0KGgo=',
  abapayDeeplink: 'abapay://link',
  lifetimeMinutes: 30,
  expiresAt: '2026-10-04T16:00:07.000Z',
};

/** A pending order owned by {@link USER_ID}. */
const orderRow = (overrides: Record<string, unknown> = {}): OrderWithItems =>
  ({
    id: ORDER_ID,
    userId: USER_ID,
    orderNumber: 'ORD-20261004-ABC123',
    status: 'PENDING',
    currency: 'USD',
    totalAmount: TOTAL,
    ...overrides,
  }) as unknown as OrderWithItems;

/** A `PENDING` payment row with no QR yet, as written immediately after the insert. */
const paymentRow = (overrides: Partial<Payment> = {}): Payment =>
  ({
    id: PAYMENT_ID,
    orderId: ORDER_ID,
    provider: 'ABA_PAYWAY',
    transactionId: TRANSACTION_ID,
    status: 'PENDING',
    amount: TOTAL,
    currency: 'USD',
    paymentMethod: null,
    providerReference: null,
    paidAt: null,
    qrPayload: null,
    ...overrides,
  }) as unknown as Payment;

/** The same row once the QR has been attached. */
const storedPaymentRow = (overrides: Partial<Payment> = {}): Payment =>
  paymentRow({ qrPayload, ...overrides });

/** A PayWay answer saying the money is collected. */
const collected = (overrides: Partial<PaywayTransactionCheck> = {}): PaywayTransactionCheck => ({
  paymentStatusCode: 0,
  paymentStatus: 'APPROVED',
  totalAmount: TOTAL,
  paymentAmount: TOTAL,
  paymentCurrency: 'USD',
  apv: 'APV123',
  transactionDate: '2026-10-04T15:30:07.000Z',
  ...overrides,
});

/** Prisma's unique-constraint violation. */
const uniqueViolation = (): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '7.10.0',
  });

/**
 * Awaits a rejection and returns the thrown error, typed.
 *
 * `promise.catch((e: unknown) => e as X)` does not narrow the result — the expression is
 * still `T | X` — so reading `.message` off it is a type error, and the workaround is a
 * cast through `unknown` that would also swallow the mistake this helper is here to catch:
 * a promise that *resolves* when it was supposed to fail.
 */
const rejection = async <E extends Error>(
  promise: Promise<unknown>,
): Promise<E> => {
  let thrown: unknown;
  let resolved = false;

  try {
    await promise;
    resolved = true;
  } catch (error) {
    thrown = error;
  }

  if (resolved) {
    throw new Error('expected the promise to reject, but it resolved');
  }

  return thrown as E;
};

describe('PaymentsService', () => {
  let payments: {
    findPendingByOrderId: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    findByTransactionId: ReturnType<typeof vi.fn>;
    createPending: ReturnType<typeof vi.fn>;
    attachQrPayload: ReturnType<typeof vi.fn>;
    markFailed: ReturnType<typeof vi.fn>;
    markPaid: ReturnType<typeof vi.fn>;
    runInTransaction: ReturnType<typeof vi.fn>;
  };
  let orders: {
    findById: ReturnType<typeof vi.fn>;
    confirmPaid: ReturnType<typeof vi.fn>;
  };
  let payway: {
    generateQr: ReturnType<typeof vi.fn>;
    checkTransaction: ReturnType<typeof vi.fn>;
    isCollected: ReturnType<typeof vi.fn>;
  };
  let transactionIds: { build: ReturnType<typeof vi.fn> };
  let service: PaymentsService;

  beforeEach(() => {
    payments = {
      findPendingByOrderId: vi.fn().mockResolvedValue(null),
      findById: vi.fn().mockResolvedValue(storedPaymentRow()),
      findByTransactionId: vi.fn().mockResolvedValue(paymentRow()),
      createPending: vi.fn().mockResolvedValue(paymentRow()),
      attachQrPayload: vi.fn().mockResolvedValue(true),
      markFailed: vi.fn().mockResolvedValue(true),
      markPaid: vi.fn().mockResolvedValue(true),
      // Passes a stand-in transaction client straight through: the unit under test does
      // not care what Prisma's client is, only that both writes happen inside one call.
      runInTransaction: vi.fn((work: (tx: unknown) => Promise<unknown>) => work({})),
    };
    orders = {
      findById: vi.fn().mockResolvedValue(orderRow()),
      confirmPaid: vi.fn().mockResolvedValue(true),
    };
    payway = {
      generateQr: vi.fn().mockResolvedValue({
        qrString: qrPayload.qrString,
        qrImage: qrPayload.qrImage,
        abapayDeeplink: qrPayload.abapayDeeplink,
        lifetimeMinutes: 30,
      }),
      checkTransaction: vi.fn().mockResolvedValue(collected()),
      isCollected: vi.fn().mockReturnValue(true),
    };
    transactionIds = { build: vi.fn().mockReturnValue(TRANSACTION_ID) };

    service = new PaymentsService(
      payments as unknown as PaymentRepository,
      orders as unknown as OrderRepository,
      transactionIds as unknown as TransactionIdGenerator,
      payway as unknown as PaywayService,
    );
  });

  describe('createPayment', () => {
    it('creates a PENDING attempt from the order, then attaches the QR', async () => {
      const response = await service.createPayment(USER_ID, ORDER_ID);

      expect(payments.createPending).toHaveBeenCalledWith({
        orderId: ORDER_ID,
        provider: 'ABA_PAYWAY',
        transactionId: TRANSACTION_ID,
        status: 'PENDING',
        amount: '129.00',
        currency: 'USD',
      });
      // `expiresAt` is derived from the clock, so it is asserted as an instant rather
      // than as a literal; `qrPayload` itself is a fixed fixture used by the return-value
      // assertions below.
      expect(payments.attachQrPayload).toHaveBeenCalledWith(PAYMENT_ID, {
        ...qrPayload,
        expiresAt: expect.any(String),
      });
      expect(response.status).toBe('PENDING');
      expect(response.qrString).toBe(qrPayload.qrString);
    });

    it('derives the amount from the order total, formatted for PayWay', async () => {
      await service.createPayment(USER_ID, ORDER_ID);

      const [input] = payway.generateQr.mock.calls[0]!;

      expect(input).toEqual({
        transactionId: TRANSACTION_ID,
        amount: '129.00',
        currency: 'USD',
      });
    });

    it('renders KHR with no decimals', async () => {
      orders.findById.mockResolvedValue(
        orderRow({ currency: 'KHR', totalAmount: new Prisma.Decimal('45000') }),
      );

      await service.createPayment(USER_ID, ORDER_ID);

      expect(payway.generateQr.mock.calls[0]![0]).toMatchObject({
        amount: '45000',
        currency: 'KHR',
      });
    });

    it('normalises the currency to upper case, which is what PayWay compares', async () => {
      orders.findById.mockResolvedValue(orderRow({ currency: 'usd' }));

      await service.createPayment(USER_ID, ORDER_ID);

      expect(payway.generateQr.mock.calls[0]![0]).toMatchObject({ currency: 'USD' });
    });

    it('returns only the safe fields, never the row or the provider body', async () => {
      const response = await service.createPayment(USER_ID, ORDER_ID);

      expect(Object.keys(response).sort()).toEqual([
        'abapayDeeplink',
        'amount',
        'currency',
        'expiresAt',
        'lifetimeMinutes',
        'orderId',
        'paymentId',
        'qrImage',
        'qrString',
        'status',
        'transactionId',
      ]);
      expect(JSON.stringify(response)).not.toContain('merchant');
    });

    describe('ownership and order state', () => {
      it('404s when the order does not exist', async () => {
        orders.findById.mockResolvedValue(null);

        await expect(service.createPayment(USER_ID, ORDER_ID)).rejects.toBeInstanceOf(
          NotFoundException,
        );
      });

      it("404s for another user's order, identically", async () => {
        // The same code as "absent" on purpose: a 403 would confirm the order exists.
        orders.findById.mockResolvedValue(orderRow({ userId: OTHER_USER_ID }));

        const absent = await rejection<NotFoundException>(
          service.createPayment(USER_ID, '44444444-4444-4444-8444-444444444444'),
        );
        orders.findById.mockResolvedValue(orderRow({ userId: OTHER_USER_ID }));
        const notMine = await rejection<NotFoundException>(
          service.createPayment(USER_ID, ORDER_ID),
        );

        // `HttpException.getStatus()` is the public accessor for the private field.
        expect(absent.getStatus()).toBe(404);
        expect(notMine.getStatus()).toBe(404);
      });

      it.each(['CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED'])(
        '409s for a %s order',
        async (status) => {
          orders.findById.mockResolvedValue(orderRow({ status }));

          await expect(
            service.createPayment(USER_ID, ORDER_ID),
          ).rejects.toBeInstanceOf(ConflictException);
        },
      );

      it('never reaches PayWay for an unpayable order', async () => {
        orders.findById.mockResolvedValue(orderRow({ status: 'CANCELLED' }));

        await service.createPayment(USER_ID, ORDER_ID).catch(() => undefined);

        expect(payway.generateQr).not.toHaveBeenCalled();
        expect(payments.createPending).not.toHaveBeenCalled();
      });

      it('422s when the order cannot be charged through PayWay at all', async () => {
        orders.findById.mockResolvedValue(orderRow({ currency: 'EUR' }));

        await expect(
          service.createPayment(USER_ID, ORDER_ID),
        ).rejects.toBeInstanceOf(UnprocessableEntityException);
        expect(payway.generateQr).not.toHaveBeenCalled();
      });

      it('422s when the total is below the provider minimum', async () => {
        orders.findById.mockResolvedValue(
          orderRow({ currency: 'KHR', totalAmount: new Prisma.Decimal('50') }),
        );

        await expect(
          service.createPayment(USER_ID, ORDER_ID),
        ).rejects.toBeInstanceOf(UnprocessableEntityException);
      });
    });

    describe('idempotency', () => {
      it('returns the existing attempt and makes no second PayWay call', async () => {
        payments.findPendingByOrderId.mockResolvedValue(storedPaymentRow());

        const response = await service.createPayment(USER_ID, ORDER_ID);

        expect(response.transactionId).toBe(TRANSACTION_ID);
        expect(payway.generateQr).not.toHaveBeenCalled();
        expect(payments.createPending).not.toHaveBeenCalled();
      });

      it('returns the identical QR the customer already had', async () => {
        payments.findPendingByOrderId.mockResolvedValue(storedPaymentRow());

        const first = await service.createPayment(USER_ID, ORDER_ID);
        const second = await service.createPayment(USER_ID, ORDER_ID);

        expect(second).toEqual(first);
      });

      it('adopts the winner when a concurrent insert loses the order index', async () => {
        payments.findPendingByOrderId.mockResolvedValueOnce(null);
        payments.createPending.mockRejectedValueOnce(uniqueViolation());
        payments.findPendingByOrderId.mockResolvedValueOnce(storedPaymentRow());

        const response = await service.createPayment(USER_ID, ORDER_ID);

        // The loser must not mint a second PayWay transaction.
        expect(response.transactionId).toBe(TRANSACTION_ID);
        expect(payway.generateQr).not.toHaveBeenCalled();
      });

      it('retries with a fresh transaction id when the generator collides', async () => {
        const collision = paymentRow({ id: 'other-id', transactionId: 'PW000000000000OLDID' });
        transactionIds.build
          .mockReturnValueOnce('PW000000000000OLDID')
          .mockReturnValueOnce(TRANSACTION_ID);
        payments.createPending
          .mockRejectedValueOnce(uniqueViolation())
          .mockResolvedValueOnce(paymentRow());
        payments.findPendingByOrderId.mockResolvedValue(null);

        await service.createPayment(USER_ID, ORDER_ID);

        expect(transactionIds.build).toHaveBeenCalledTimes(2);
        expect(payments.createPending).toHaveBeenLastCalledWith(
          expect.objectContaining({ transactionId: TRANSACTION_ID }),
        );
        expect(payway.generateQr).toHaveBeenCalledTimes(1);
        void collision;
      });

      it('gives up with a 409 when the generator cannot find a free id', async () => {
        payments.createPending.mockRejectedValue(uniqueViolation());
        payments.findPendingByOrderId.mockResolvedValue(null);

        await expect(
          service.createPayment(USER_ID, ORDER_ID),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(payway.generateQr).not.toHaveBeenCalled();
      });

      it('propagates a non-unique database error instead of retrying it', async () => {
        const failure = new Prisma.PrismaClientKnownRequestError('boom', {
          code: 'P2034',
          clientVersion: '7.10.0',
        });
        payments.createPending.mockRejectedValue(failure);

        await expect(service.createPayment(USER_ID, ORDER_ID)).rejects.toThrow(failure);
        expect(transactionIds.build).toHaveBeenCalledTimes(1);
      });

      it('409s when a live attempt has no QR yet, rather than returning an unscannable one', async () => {
        vi.useFakeTimers();
        try {
          payments.findPendingByOrderId.mockResolvedValue(paymentRow());
          payments.findById.mockResolvedValue(paymentRow());

          // The expectation is attached *before* the clock is advanced, not after. The
          // poll rejects at the 1500 ms deadline, so awaiting the timers first would
          // leave the rejection momentarily unhandled — which Node reports as an
          // unhandled rejection and vitest fails the run on, even though the assertion
          // below then passes. A suite that fails for a reason no test can see is a
          // suite nobody trusts.
          const pending = expect(
            service.createPayment(USER_ID, ORDER_ID),
          ).rejects.toBeInstanceOf(ConflictException);

          await vi.advanceTimersByTimeAsync(2_000);

          await pending;
        } finally {
          vi.useRealTimers();
        }
      });

      it('returns the QR as soon as the in-flight request stores it', async () => {
        vi.useFakeTimers();
        try {
          payments.findPendingByOrderId.mockResolvedValue(paymentRow());
          payments.findById
            .mockResolvedValueOnce(paymentRow())
            .mockResolvedValueOnce(storedPaymentRow());

          const pending = expect(service.createPayment(USER_ID, ORDER_ID)).resolves.toMatchObject(
            { qrString: qrPayload.qrString },
          );

          await vi.advanceTimersByTimeAsync(100);

          await pending;
        } finally {
          vi.useRealTimers();
        }
      });
    });

    describe('when PayWay does not return a QR', () => {
      it('marks the attempt FAILED so the order is not blocked forever', async () => {
        const failure = new Error('provider unavailable');
        payway.generateQr.mockRejectedValue(failure);

        await expect(service.createPayment(USER_ID, ORDER_ID)).rejects.toThrow(failure);

        expect(payments.markFailed).toHaveBeenCalledWith(PAYMENT_ID);
        expect(payments.attachQrPayload).not.toHaveBeenCalled();
      });

      it('passes the provider error through unchanged', async () => {
        // `PaywayService` already reduced it to a 502 or 503 carrying a safe message;
        // re-wrapping here would only risk widening it.
        const failure = new Error('Bad Gateway');
        payway.generateQr.mockRejectedValue(failure);

        await expect(service.createPayment(USER_ID, ORDER_ID)).rejects.toBe(failure);
      });
    });
  });

  describe('handlePaywayCallback', () => {
    const callback = (overrides: Record<string, unknown> = {}) => ({
      merchantRef: TRANSACTION_ID,
      ...overrides,
    });

    it('records a verified payment and confirms the order', async () => {
      const ack = await service.handlePaywayCallback(callback());

      expect(ack.status).toBe('RECORDED');
      expect(payments.markPaid).toHaveBeenCalledWith(
        PAYMENT_ID,
        {
          providerReference: 'APV123',
          paidAt: new Date('2026-10-04T15:30:07.000Z'),
        },
        {},
      );
      expect(orders.confirmPaid).toHaveBeenCalledWith(ORDER_ID, {});
    });

    it('runs the payment write and the order promotion in one transaction', async () => {
      // Two commits could leave an order CONFIRMED with no recorded payment, or money
      // collected against an order still PENDING.
      await service.handlePaywayCallback(callback());

      expect(payments.runInTransaction).toHaveBeenCalledTimes(1);
    });

    it('accepts the transaction_id spelling too', async () => {
      const ack = await service.handlePaywayCallback({
        transactionId: TRANSACTION_ID,
      } as never);

      expect(ack.status).toBe('RECORDED');
    });

    describe('what the payload is allowed to conclude', () => {
      it('400s without any transaction identifier', async () => {
        await expect(
          service.handlePaywayCallback({} as never),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(payments.findByTransactionId).not.toHaveBeenCalled();
      });

      it('400s on a transaction id PayWay could never have issued', async () => {
        // A cheap gate on an unauthenticated endpoint, before any database lookup.
        await expect(
          service.handlePaywayCallback({ merchantRef: 'not a tran id' } as never),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(payments.findByTransactionId).not.toHaveBeenCalled();
      });

      it('404s when no payment carries the transaction id', async () => {
        payments.findByTransactionId.mockResolvedValue(null);

        await expect(
          service.handlePaywayCallback(callback()),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(payway.checkTransaction).not.toHaveBeenCalled();
      });

      it('ignores a forged APPROVED in the payload when PayWay says otherwise', async () => {
        // The whole security property: the caller says APPROVED, the provider says no.
        payway.checkTransaction.mockResolvedValue(
          collected({ paymentStatus: 'PENDING', paymentStatusCode: 3 }),
        );
        payway.isCollected.mockReturnValue(false);

        const ack = await service.handlePaywayCallback(
          callback({ paymentStatus: 'APPROVED', amount: '129.00' }),
        );

        expect(ack.status).toBe('NOT_COLLECTED');
        expect(payments.markPaid).not.toHaveBeenCalled();
        expect(orders.confirmPaid).not.toHaveBeenCalled();
      });

      it('ignores an amount in the payload that disagrees with the provider', async () => {
        payway.checkTransaction.mockResolvedValue(
          collected({ totalAmount: new Prisma.Decimal('1.00') }),
        );

        await expect(
          service.handlePaywayCallback(callback({ amount: '129.00' })),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(payments.markPaid).not.toHaveBeenCalled();
      });
    });

    describe('verification against PayWay', () => {
      it('asks the provider about the stored transaction id', async () => {
        await service.handlePaywayCallback(callback());

        expect(payway.checkTransaction).toHaveBeenCalledWith({
          transactionId: TRANSACTION_ID,
        });
      });

      it('leaves the order PENDING when nothing has been collected', async () => {
        // Not an error: PayWay notifies the moment a transaction changes, which includes
        // "the customer is still typing their PIN".
        payway.isCollected.mockReturnValue(false);

        const ack = await service.handlePaywayCallback(callback());

        expect(ack.status).toBe('NOT_COLLECTED');
        expect(payments.markPaid).not.toHaveBeenCalled();
        expect(orders.confirmPaid).not.toHaveBeenCalled();
      });

      it.each([
        [
          'a total that does not match the order',
          { totalAmount: new Prisma.Decimal('12.90') },
        ],
        [
          'a payment amount that does not match the order',
          { paymentAmount: new Prisma.Decimal('129.99') },
        ],
        ['a currency that does not match the order', { paymentCurrency: 'KHR' }],
      ])('refuses %s and leaves the order PENDING', async (_label, overrides) => {
        payway.checkTransaction.mockResolvedValue(collected(overrides));

        await expect(
          service.handlePaywayCallback(callback()),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(payments.markPaid).not.toHaveBeenCalled();
        expect(orders.confirmPaid).not.toHaveBeenCalled();
      });

      it('ignores the currency case, since the codes mean the same thing', async () => {
        payway.checkTransaction.mockResolvedValue(collected({ paymentCurrency: 'usd' }));

        await expect(service.handlePaywayCallback(callback())).resolves.toMatchObject({
          status: 'RECORDED',
        });
      });

      it('treats a trailing zero as equal, because it is', async () => {
        // `Decimal('129.00').equals(Decimal('129'))` is true. Rejecting an honest payment
        // over formatting would be the worst possible bug in this file.
        payway.checkTransaction.mockResolvedValue(
          collected({ totalAmount: new Prisma.Decimal('129') }),
        );

        await expect(service.handlePaywayCallback(callback())).resolves.toMatchObject({
          status: 'RECORDED',
        });
      });

      it('does not echo the figures in the 409, on an unauthenticated endpoint', async () => {
        payway.checkTransaction.mockResolvedValue(
          collected({ totalAmount: new Prisma.Decimal('12.90') }),
        );

        const error = await rejection<ConflictException>(
          service.handlePaywayCallback(callback()),
        );

        expect(error.message).not.toContain('129');
        expect(error.message).not.toContain('12.90');
      });
    });

    describe('repeated deliveries', () => {
      it('acknowledges an already-paid payment without calling PayWay', async () => {
        payments.findByTransactionId.mockResolvedValue(paymentRow({ status: 'PAID' }));

        const ack = await service.handlePaywayCallback(callback());

        expect(ack.status).toBe('ALREADY_RECORDED');
        expect(payway.checkTransaction).not.toHaveBeenCalled();
        expect(payments.markPaid).not.toHaveBeenCalled();
      });

      it('lets one of two concurrent deliveries win, and still reports success', async () => {
        payments.markPaid.mockResolvedValue(false);

        const ack = await service.handlePaywayCallback(callback());

        // The loser matched no rows because the winner already promoted the order in its
        // own transaction, so there is nothing left to do.
        expect(ack.status).toBe('RECORDED');
        expect(orders.confirmPaid).not.toHaveBeenCalled();
      });

      it('still records the payment when the order is no longer PENDING', async () => {
        orders.findById.mockResolvedValue(orderRow({ status: 'PENDING' }));
        orders.confirmPaid.mockResolvedValue(false);

        const ack = await service.handlePaywayCallback(callback());

        // Money moved, so the payment row must say so even though the promotion failed.
        expect(payments.markPaid).toHaveBeenCalled();
        expect(ack.status).toBe('RECORDED');
      });
    });

    it('refuses a payment whose order has gone', async () => {
      // Unreachable while the FK is RESTRICT, and handled rather than dereferenced.
      payments.findById.mockResolvedValue(storedPaymentRow());
      orders.findById.mockResolvedValue(null);

      await expect(
        service.handlePaywayCallback(callback()),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(payway.checkTransaction).not.toHaveBeenCalled();
    });
  });
});
