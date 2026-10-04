import { BadGatewayException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { readPaywayConfig } from './payway.config.js';
import { PaywayService } from './payway.service.js';
import type {
  PaywayHttpClient,
  PaywayHttpResponse,
} from './payway.types.js';

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

const API_KEY = 'api-key-that-must-never-be-logged';
const MERCHANT_ID = 'lw00000000';
const CALLBACK_URL = 'https://example.test/payments/aba-payway/callback';

/** A `PaywayHttpResponse` carrying `body`, as JSON. */
const jsonResponse = (body: unknown, init: { ok?: boolean; status?: number } = {}): PaywayHttpResponse => ({
  ok: init.ok ?? true,
  status: init.status ?? 200,
  text: () => Promise.resolve(JSON.stringify(body)),
});

const service = (client: PaywayHttpClient, env: NodeJS.ProcessEnv = {}) =>
  new PaywayService(client, readPaywayConfig({
    PAYWAY_MERCHANT_ID: MERCHANT_ID,
    PAYWAY_API_KEY: API_KEY,
    PAYWAY_CALLBACK_URL: CALLBACK_URL,
    ...env,
  }));

/** The success body PayWay returns from generate-qr. */
const qrSuccess = {
  status: { code: '0', message: 'Success', trace_id: 'trace-1' },
  qrString: '00020101021129...',
  qrImage: 'data:image/png;base64,iVBORw0KGgo=',
  abapay_deeplink: 'abapay://link',
};

/** The success body PayWay returns from check-transaction-2. */
const checkSuccess = (overrides: Record<string, unknown> = {}) => ({
  status: { code: '00', message: 'Success', trace_id: 'trace-2', tran_id: 'PW261004153007ABC123' },
  data: {
    payment_status_code: 0,
    payment_status: 'APPROVED',
    total_amount: 129,
    payment_amount: 129,
    payment_currency: 'USD',
    apv: 'APV123',
    transaction_date: '2026-10-04T15:30:07+07:00',
  },
  ...overrides,
});

describe('PaywayService', () => {
  describe('generateQr', () => {
    it('returns the QR, image and deep link PayWay supplied', async () => {
      const client = vi.fn<PaywayHttpClient>().mockResolvedValue(jsonResponse(qrSuccess));

      const qr = await service(client).generateQr({
        transactionId: 'PW261004153007ABC123',
        amount: '129.00',
        currency: 'USD',
      });

      expect(qr).toEqual({
        qrString: '00020101021129...',
        qrImage: 'data:image/png;base64,iVBORw0KGgo=',
        abapayDeeplink: 'abapay://link',
        lifetimeMinutes: 30,
      });
    });

    it('omits the image and deep link when PayWay sends none', async () => {
      const client = vi
        .fn<PaywayHttpClient>()
        .mockResolvedValue(jsonResponse({ status: { code: '0' }, qrString: 'qr' }));

      const qr = await service(client).generateQr({
        transactionId: 'PW261004153007ABC123',
        amount: '129.00',
        currency: 'USD',
      });

      expect(qr.qrString).toBe('qr');
      expect(qr.qrImage).toBeUndefined();
      expect(qr.abapayDeeplink).toBeUndefined();
    });

    it('sends the server-derived amount and currency, never anything else', async () => {
      const client = vi.fn<PaywayHttpClient>().mockResolvedValue(jsonResponse(qrSuccess));

      await service(client).generateQr({
        transactionId: 'PW261004153007ABC123',
        amount: '129.00',
        currency: 'USD',
      });

      const [, init] = client.mock.calls[0]!;
      const body = JSON.parse(init.body as string) as Record<string, unknown>;

      expect(body.amount).toBe('129.00');
      expect(body.currency).toBe('USD');
      expect(body.merchant_id).toBe(MERCHANT_ID);
      expect(body.tran_id).toBe('PW261004153007ABC123');
      expect(body.payment_option).toBe('abapay_khqr');
      expect(body.purchase_type).toBe('purchase');
      expect(body.lifetime).toBe(30);
      expect(body.qr_image_template).toBe('template3_color');
    });

    it('sends the callback URL Base64-encoded', async () => {
      const client = vi.fn<PaywayHttpClient>().mockResolvedValue(jsonResponse(qrSuccess));

      await service(client).generateQr({
        transactionId: 'PW261004153007ABC123',
        amount: '129.00',
        currency: 'USD',
      });

      const [, init] = client.mock.calls[0]!;
      const body = JSON.parse(init.body as string) as Record<string, string>;

      expect(Buffer.from(body.callback_url!, 'base64').toString('utf8')).toBe(
        CALLBACK_URL,
      );
    });

    it('sends every optional field as an empty string rather than omitting it', async () => {
      const client = vi.fn<PaywayHttpClient>().mockResolvedValue(jsonResponse(qrSuccess));

      await service(client).generateQr({
        transactionId: 'PW261004153007ABC123',
        amount: '129.00',
        currency: 'USD',
      });

      const [, init] = client.mock.calls[0]!;
      const body = JSON.parse(init.body as string) as Record<string, unknown>;

      // PayWay concatenates all nineteen values in a fixed order; a field absent from the
      // body must still occupy its position in the signed string.
      for (const field of [
        'items',
        'first_name',
        'last_name',
        'email',
        'phone',
        'return_deeplink',
        'custom_fields',
        'return_params',
        'payout',
      ]) {
        expect(body[field]).toBe('');
      }
    });

    it('never puts the API key anywhere in the request', async () => {
      const client = vi.fn<PaywayHttpClient>().mockResolvedValue(jsonResponse(qrSuccess));

      await service(client).generateQr({
        transactionId: 'PW261004153007ABC123',
        amount: '129.00',
        currency: 'USD',
      });

      const [url, init] = client.mock.calls[0]!;

      expect(`${url}${init.body}`).not.toContain(API_KEY);
      expect(JSON.stringify(init.headers)).not.toContain(API_KEY);
    });

    it('signs the request', async () => {
      const client = vi.fn<PaywayHttpClient>().mockResolvedValue(jsonResponse(qrSuccess));

      await service(client).generateQr({
        transactionId: 'PW261004153007ABC123',
        amount: '129.00',
        currency: 'USD',
      });

      const [, init] = client.mock.calls[0]!;
      const body = JSON.parse(init.body as string) as Record<string, string>;

      // Base64 of a 64-byte SHA-512 digest.
      expect(body.hash).toMatch(/^[A-Za-z0-9+/]{86}==$/);
    });

    it('refuses to call PayWay when it is not configured', async () => {
      const client = vi.fn<PaywayHttpClient>();

      await expect(
        new PaywayService(client, readPaywayConfig({})).generateQr({
          transactionId: 'PW261004153007ABC123',
          amount: '129.00',
          currency: 'USD',
        }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      // A 503 must not become a request: "we cannot take payments" has to be
      // distinguishable from "PayWay refused".
      expect(client).not.toHaveBeenCalled();
    });

    it('answers 503 with a message that reveals nothing about the deployment', async () => {
      const client = vi.fn<PaywayHttpClient>();
      const error = await rejection<ServiceUnavailableException>(
        new PaywayService(client, readPaywayConfig({})).generateQr({
          transactionId: 'PW261004153007ABC123',
          amount: '129.00',
          currency: 'USD',
        }),
      );

      expect(error.message).not.toContain('PAYWAY_API_KEY');
      expect(error.message).not.toContain('MERCHANT');
    });

    describe('when PayWay refuses', () => {
      it('treats a non-success status code as a 502, because PayWay answers 200 for failures', async () => {
        const client = vi.fn<PaywayHttpClient>().mockResolvedValue(
          jsonResponse({
            status: { code: '1', message: 'Invalid amount', trace_id: 'trace-9' },
          }),
        );

        await expect(
          service(client).generateQr({
            transactionId: 'PW261004153007ABC123',
            amount: '129.00',
            currency: 'USD',
          }),
        ).rejects.toBeInstanceOf(BadGatewayException);
      });

      it("surfaces PayWay's own explanation, which names no credential", async () => {
        // Without this a merchant cannot diagnose a rejected QR, and swallowing it would
        // be the more "safe" choice that helps nobody.
        const client = vi.fn<PaywayHttpClient>().mockResolvedValue(
          jsonResponse({
            status: { code: '13', message: 'KHR Amount must be greater than 100 KHR' },
          }),
        );

        const error = await rejection<BadGatewayException>(
          service(client).generateQr({
            transactionId: 'PW261004153007ABC123',
            amount: '50',
            currency: 'KHR',
          }),
        );

        expect(error.message).toBe('KHR Amount must be greater than 100 KHR');
      });

      it('rejects a success code with no qrString, rather than returning an unscannable payment', async () => {
        const client = vi
          .fn<PaywayHttpClient>()
          .mockResolvedValue(jsonResponse({ status: { code: '0' } }));

        await expect(
          service(client).generateQr({
            transactionId: 'PW261004153007ABC123',
            amount: '129.00',
            currency: 'USD',
          }),
        ).rejects.toBeInstanceOf(BadGatewayException);
      });

      it('handles a numeric status code without mistaking it for success', async () => {
        // PayWay documents some failure codes as numbers. `=== '0'` must not match.
        const client = vi
          .fn<PaywayHttpClient>()
          .mockResolvedValue(jsonResponse({ status: { code: 0 }, qrString: 'qr' }));

        await expect(
          service(client).generateQr({
            transactionId: 'PW261004153007ABC123',
            amount: '129.00',
            currency: 'USD',
          }),
        ).resolves.toMatchObject({ qrString: 'qr' });

        const failing = vi
          .fn<PaywayHttpClient>()
          .mockResolvedValue(jsonResponse({ status: { code: 13 }, qrString: 'qr' }));

        await expect(
          service(failing).generateQr({
            transactionId: 'PW261004153007ABC123',
            amount: '129.00',
            currency: 'USD',
          }),
        ).rejects.toBeInstanceOf(BadGatewayException);
      });
    });

    describe('transport failures', () => {
      it.each([
        ['a network error', () => Promise.reject(new Error('ECONNREFUSED'))],
        ['a timeout', () => Promise.reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))],
      ])('reports %s as a 502 with no internal detail', async (_label, impl) => {
        const client = vi.fn<PaywayHttpClient>().mockImplementation(impl);

        const error = await rejection<BadGatewayException>(
          service(client).generateQr({
            transactionId: 'PW261004153007ABC123',
            amount: '129.00',
            currency: 'USD',
          }),
        );

        expect(error).toBeInstanceOf(BadGatewayException);
        expect(error.message).not.toContain('ECONNREFUSED');
        expect(error.message).not.toContain('PAYWAY');
      });

      it('reports a non-2xx HTTP status as a 502', async () => {
        const client = vi
          .fn<PaywayHttpClient>()
          .mockResolvedValue(jsonResponse({}, { ok: false, status: 500 }));

        await expect(
          service(client).generateQr({
            transactionId: 'PW261004153007ABC123',
            amount: '129.00',
            currency: 'USD',
          }),
        ).rejects.toBeInstanceOf(BadGatewayException);
      });

      it('reports an unparseable body as a 502 rather than crashing', async () => {
        const client = vi.fn<PaywayHttpClient>().mockResolvedValue({
          ok: true,
          status: 200,
          text: () => Promise.resolve('<html>gateway timeout</html>'),
        });

        await expect(
          service(client).generateQr({
            transactionId: 'PW261004153007ABC123',
            amount: '129.00',
            currency: 'USD',
          }),
        ).rejects.toBeInstanceOf(BadGatewayException);
      });

      it('sets a timeout signal, so a hung provider cannot pin a request open', async () => {
        const client = vi.fn<PaywayHttpClient>().mockResolvedValue(jsonResponse(qrSuccess));

        await service(client).generateQr({
          transactionId: 'PW261004153007ABC123',
          amount: '129.00',
          currency: 'USD',
        });

        const [, init] = client.mock.calls[0]!;

        expect(init.signal).toBeInstanceOf(AbortSignal);
      });
    });
  });

  describe('checkTransaction', () => {
    const transactionId = 'PW261004153007ABC123';

    it('returns the verified status and amounts as decimals', async () => {
      const client = vi.fn<PaywayHttpClient>().mockResolvedValue(jsonResponse(checkSuccess()));

      const check = await service(client).checkTransaction({ transactionId });

      expect(check.paymentStatusCode).toBe(0);
      expect(check.paymentStatus).toBe('APPROVED');
      expect(check.totalAmount).toBeInstanceOf(Prisma.Decimal);
      expect(check.totalAmount.equals(new Prisma.Decimal('129'))).toBe(true);
      expect(check.paymentCurrency).toBe('USD');
      expect(check.apv).toBe('APV123');
    });

    it('sends exactly the three signed fields PayWay documents', async () => {
      const client = vi.fn<PaywayHttpClient>().mockResolvedValue(jsonResponse(checkSuccess()));

      await service(client).checkTransaction({ transactionId });

      const [, init] = client.mock.calls[0]!;
      const body = JSON.parse(init.body as string) as Record<string, unknown>;

      expect(Object.keys(body).sort()).toEqual([
        'hash',
        'merchant_id',
        'req_time',
        'tran_id',
      ]);
      expect(`${init.body}`).not.toContain(API_KEY);
    });

    it('refuses a reply about a different transaction', async () => {
      // The reply would describe some other payment, and believing it would be far worse
      // than a timeout.
      const client = vi
        .fn<PaywayHttpClient>()
        .mockResolvedValue(
          jsonResponse(
            checkSuccess({
              status: {
                code: '00',
                tran_id: 'PW261004153007ZZZZZZ',
              },
            }),
          ),
        );

      await expect(
        service(client).checkTransaction({ transactionId }),
      ).rejects.toBeInstanceOf(BadGatewayException);
    });

    it('requires the two-decimal success code, not the generate-QR one', async () => {
      // `'0'` is success for generate-qr and a failure here. Sharing one constant across
      // the two endpoints would silently accept every error reply.
      const client = vi
        .fn<PaywayHttpClient>()
        .mockResolvedValue(jsonResponse(checkSuccess({ status: { code: '0', tran_id: transactionId } })));

      await expect(
        service(client).checkTransaction({ transactionId }),
      ).rejects.toBeInstanceOf(BadGatewayException);
    });

    it('rejects an unusable payload rather than returning partial data', async () => {
      const client = vi
        .fn<PaywayHttpClient>()
        .mockResolvedValue(
          jsonResponse(checkSuccess({ data: { payment_status_code: 0 } })),
        );

      await expect(
        service(client).checkTransaction({ transactionId }),
      ).rejects.toBeInstanceOf(BadGatewayException);
    });

    it('falls back to total_amount when payment_amount is absent', async () => {
      const client = vi.fn<PaywayHttpClient>().mockResolvedValue(
        jsonResponse(
          checkSuccess({
            data: {
              payment_status_code: 0,
              payment_status: 'APPROVED',
              total_amount: '129.00',
              payment_currency: 'USD',
            },
          }),
        ),
      );

      const check = await service(client).checkTransaction({ transactionId });

      expect(check.paymentAmount.equals(new Prisma.Decimal('129'))).toBe(true);
    });

    it('reads a JSON number without inheriting its binary error', async () => {
      const client = vi.fn<PaywayHttpClient>().mockResolvedValue(
        jsonResponse(
          checkSuccess({
            data: {
              payment_status_code: 0,
              payment_status: 'APPROVED',
              total_amount: 0.07,
              payment_amount: 0.07,
              payment_currency: 'USD',
            },
          }),
        ),
      );

      const check = await service(client).checkTransaction({ transactionId });

      expect(check.totalAmount.toFixed(2)).toBe('0.07');
    });

    it('refuses to call PayWay when it is not configured', async () => {
      const client = vi.fn<PaywayHttpClient>();

      await expect(
        new PaywayService(client, readPaywayConfig({})).checkTransaction({
          transactionId,
        }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      expect(client).not.toHaveBeenCalled();
    });
  });

  describe('isCollected', () => {
    const check = (overrides: Record<string, unknown> = {}) => ({
      paymentStatusCode: 0,
      paymentStatus: 'APPROVED',
      totalAmount: new Prisma.Decimal('129'),
      paymentAmount: new Prisma.Decimal('129'),
      paymentCurrency: 'USD',
      ...overrides,
    });

    it('accepts only code 0 with APPROVED', () => {
      expect(service(vi.fn()).isCollected(check())).toBe(true);
    });

    it.each([
      ['PRE-AUTH', { paymentStatus: 'PRE-AUTH' }],
      ['PENDING', { paymentStatus: 'PENDING' }],
      ['REFUNDED', { paymentStatus: 'REFUNDED' }],
      ['DECLINED', { paymentStatus: 'DECLINED' }],
      ['CANCELLED', { paymentStatus: 'CANCELLED' }],
      ['a non-zero code', { paymentStatusCode: 1 }],
      ['a negative code', { paymentStatusCode: -1 }],
    ])('refuses %s', (_label, overrides) => {
      // PRE-AUTH matters most: its code is also 0, and a hold is not a capture. This
      // project never requests one, so seeing it means something other than what we asked
      // for happened.
      expect(service(vi.fn()).isCollected(check(overrides))).toBe(false);
    });

    it('refuses an approved status whose code is not zero', () => {
      expect(
        service(vi.fn()).isCollected(check({ paymentStatusCode: 2 })),
      ).toBe(false);
    });
  });
});
