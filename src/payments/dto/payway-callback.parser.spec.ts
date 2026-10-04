import { BadRequestException } from '@nestjs/common';
import { parsePaywayCallback } from './payway-callback.parser.js';

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

/**
 * The webhook parser is the only place where this project decides how much of what a
 * third party sends it to believe, so its two halves are tested separately:
 *
 * - **shape** — is this a well-formed body at all?
 * - **tolerance** — does an *unrecognised* field pass?
 *
 * The second matters more than it looks. The global `ValidationPipe` is configured with
 * `forbidNonWhitelisted`, which is right for our own clients and catastrophic here: the
 * day PayWay adds a field to its callback, every customer payment would stop being
 * recorded and the orders would stay `PENDING` forever. Nothing in this file may reject
 * a key simply because it is new.
 */
describe('parsePaywayCallback', () => {
  describe('a well-formed body', () => {
    it('reads merchant_ref as the transaction id', async () => {
      const dto = await parsePaywayCallback({
        merchant_ref: 'PW261004153007ABC123',
      });

      expect(dto.merchantRef).toBe('PW261004153007ABC123');
    });

    it('reads the transaction_id spelling as a fallback', async () => {
      const dto = await parsePaywayCallback({
        transaction_id: 'PW261004153007ABC123',
      });

      expect(dto.transactionId).toBe('PW261004153007ABC123');
    });

    it('carries the diagnostic fields through for logging', async () => {
      const dto = await parsePaywayCallback({
        merchant_ref: 'PW261004153007ABC123',
        payment_status: 'APPROVED',
        payment_status_code: '0',
        amount: '129.00',
        currency: 'USD',
        apv: '987654',
        transaction_date: '2026-10-04T15:30:07Z',
      });

      expect(dto.paymentStatus).toBe('APPROVED');
      expect(dto.paymentStatusCode).toBe('0');
      expect(dto.amount).toBe('129.00');
      expect(dto.currency).toBe('USD');
      expect(dto.apv).toBe('987654');
      expect(dto.transactionDate).toBe('2026-10-04T15:30:07Z');
    });

    it('accepts an empty object, which leaves the lookup to fail cleanly', async () => {
      // Not a 400 here: a body with no identifier is a well-formed *request* that simply
      // identifies nothing, and the service answers that with its own 400.
      const dto = await parsePaywayCallback({});

      expect(dto.merchantRef).toBeUndefined();
      expect(dto.transactionId).toBeUndefined();
    });
  });

  describe('tolerance of provider fields this project does not know', () => {
    it('ignores an unrecognised key instead of rejecting the body', async () => {
      const dto = await parsePaywayCallback({
        merchant_ref: 'PW261004153007ABC123',
        some_future_payway_field: 'whatever PayWay decides to send',
        nested: { deeply: { unexpected: true } },
      });

      expect(dto.merchantRef).toBe('PW261004153007ABC123');
    });

    it('does not copy unknown keys onto the returned object', async () => {
      const dto = await parsePaywayCallback({
        merchant_ref: 'PW261004153007ABC123',
        some_future_payway_field: 'secret-ish provider data',
      });

      // So a stray `console.log(dto)` in a future debug session cannot print it.
      expect(Object.keys(dto)).not.toContain('some_future_payway_field');
    });
  });

  describe('a malformed body', () => {
    it.each([
      ['null', null],
      ['a string', 'merchant_ref'],
      ['a number', 42],
      ['an array', [{ merchant_ref: 'PW261004153007ABC123' }]],
      ['a boolean', true],
    ])('rejects %s', async (_label, body) => {
      // `JSON.parse` succeeds for all of these, so treating any of them as a DTO would
      // have the service reading properties off a string.
      await expect(parsePaywayCallback(body)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('rejects a merchant_ref that is not a string', async () => {
      await expect(
        parsePaywayCallback({ merchant_ref: { nested: 'object' } }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a merchant_ref longer than PayWay allows', async () => {
      await expect(
        parsePaywayCallback({ merchant_ref: 'a'.repeat(21) }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a currency longer than three characters', async () => {
      await expect(
        parsePaywayCallback({ merchant_ref: 'PW1', currency: 'DOLLARS' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('names the offending field without echoing its value', async () => {
      // The endpoint is unauthenticated, so the 400 body must not reflect an attacker's
      // payload back at them.
      const error = await rejection<BadRequestException>(
        parsePaywayCallback({ merchant_ref: { attempt: 'injection' } }),
      );

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.message).toContain('merchantRef');
      expect(error.message).not.toContain('injection');
    });
  });
});
