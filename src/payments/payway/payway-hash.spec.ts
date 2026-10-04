import { createHmac } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client.js';
import { PAYWAY_MAX_TRANSACTION_ID_LENGTH } from './payway.constants.js';
import {
  encodePaywayBase64,
  formatPaywayAmount,
  formatPaywayRequestTime,
  hashesMatch,
  isSupportedCurrency,
  isValidPaywayTransactionId,
  signPaywayCheckTransactionRequest,
  signPaywayQrRequest,
} from './payway-hash.js';

/**
 * The request signing is the one piece of this integration that has to agree with a
 * third party's implementation byte for byte, and a mismatch is invisible locally: the
 * call succeeds, PayWay answers `invalid hash`, and the only symptom is that no payment
 * ever works.
 *
 * So these tests do not re-implement the hash. Each one builds an *independent* HMAC
 * from the documented field order and asserts the production code agrees — if both used
 * the same helper with the same bug, the suite would pass and payments would still be
 * broken, so the expected value has to be produced a second way.
 */
describe('PayWay request signing', () => {
  const apiKey = 'test-api-key-do-not-log';

  /** An independent HMAC over the documented order. Deliberately not the production code. */
  const expectedHash = (...values: string[]): string =>
    createHmac('sha512', apiKey).update(values.join(''), 'utf8').digest('base64');

  describe('signPaywayQrRequest', () => {
    const signable = {
      reqTime: '20261004153000',
      merchantId: 'lw00000000',
      transactionId: 'PW261004153000-ABC123',
      amount: '129.00',
      items: '',
      firstName: '',
      lastName: '',
      email: '',
      phone: '',
      purchaseType: 'purchase',
      paymentOption: 'abapay_khqr',
      // Base64 of `https://example.test/payments/aba-payway/callback`.
      callbackUrl: 'aHR0cHM6Ly9leGFtcGxlLnRlc3QvcGF5bWVudHMvYWJhLXBheXdheS9jYWxsYmFjaw==',
      returnDeeplink: '',
      currency: 'USD',
      customFields: '',
      returnParams: '',
      payout: '',
      lifetimeMinutes: 30,
      qrImageTemplate: 'template3_color',
    };

    it('signs the nineteen documented values in PayWay order', () => {
      expect(signPaywayQrRequest(apiKey, signable)).toBe(
        expectedHash(
          '20261004153000',
          'lw00000000',
          'PW261004153000-ABC123',
          '129.00',
          '',
          '',
          '',
          '',
          '',
          'purchase',
          'abapay_khqr',
          signable.callbackUrl,
          '',
          'USD',
          '',
          '',
          '',
          '30',
          'template3_color',
        ),
      );
    });

    it('includes the optional values PayWay was actually given', () => {
      const withBuyer = {
        ...signable,
        firstName: 'Sokha',
        lastName: 'Chhim',
        email: 'sokha@example.test',
        phone: '012345678',
      };

      expect(signPaywayQrRequest(apiKey, withBuyer)).toBe(
        expectedHash(
          withBuyer.reqTime,
          withBuyer.merchantId,
          withBuyer.transactionId,
          withBuyer.amount,
          withBuyer.items,
          'Sokha',
          'Chhim',
          'sokha@example.test',
          '012345678',
          withBuyer.purchaseType,
          withBuyer.paymentOption,
          withBuyer.callbackUrl,
          withBuyer.returnDeeplink,
          withBuyer.currency,
          withBuyer.customFields,
          withBuyer.returnParams,
          withBuyer.payout,
          '30',
          withBuyer.qrImageTemplate,
        ),
      );
    });

    it('changes the hash when any single value changes', () => {
      const baseline = signPaywayQrRequest(apiKey, signable);

      // One assertion per position would be nineteen near-identical tests; changing the
      // amount, the transaction id and the currency between them covers a reordered
      // concatenation, a dropped field and a swapped pair, which are the three ways this
      // kind of bug actually shows up.
      expect(signPaywayQrRequest(apiKey, { ...signable, amount: '129.01' })).not.toBe(
        baseline,
      );
      expect(
        signPaywayQrRequest(apiKey, {
          ...signable,
          transactionId: 'PW261004153000-ABC124',
        }),
      ).not.toBe(baseline);
      expect(signPaywayQrRequest(apiKey, { ...signable, currency: 'KHR' })).not.toBe(
        baseline,
      );
    });

    it('is not a plain SHA-512 of the values', () => {
      // Guards against a refactor dropping the key or swapping the digest, either of
      // which would produce a stable-looking hash that PayWay silently rejects.
      const unsigned = createHmac('sha512', '')
        .update('20261004153000', 'utf8')
        .digest('base64');

      expect(signPaywayQrRequest(apiKey, signable)).not.toBe(unsigned);
    });

    it('never embeds the API key in the signed string', () => {
      // The hash is the only thing derived from the key that leaves the process; if the
      // key were one of the concatenated values it would be transmitted in clear.
      expect(signPaywayQrRequest(apiKey, signable)).not.toContain(apiKey);
    });
  });

  describe('signPaywayCheckTransactionRequest', () => {
    it('signs exactly req_time, merchant_id and tran_id', () => {
      expect(
        signPaywayCheckTransactionRequest(apiKey, {
          reqTime: '20261004153000',
          merchantId: 'lw00000000',
          transactionId: 'PW261004153000-ABC123',
        }),
      ).toBe(
        expectedHash(
          '20261004153000',
          'lw00000000',
          'PW261004153000-ABC123',
        ),
      );
    });

    it('differs from the QR signature for the same transaction', () => {
      const common = {
        reqTime: '20261004153000',
        merchantId: 'lw00000000',
        transactionId: 'PW261004153000-ABC123',
      };

      // The two endpoints sign different field lists, so a signature valid for one must
      // not be valid for the other. Sharing a helper between them would be a live bug.
      expect(
        signPaywayCheckTransactionRequest(apiKey, common),
      ).not.toBe(
        signPaywayQrRequest(apiKey, {
          ...common,
          amount: '129.00',
          items: '',
          firstName: '',
          lastName: '',
          email: '',
          phone: '',
          purchaseType: 'purchase',
          paymentOption: 'abapay_khqr',
          callbackUrl: '',
          returnDeeplink: '',
          currency: 'USD',
          customFields: '',
          returnParams: '',
          payout: '',
          lifetimeMinutes: 30,
          qrImageTemplate: 'template3_color',
        }),
      );
    });
  });

  describe('hashesMatch', () => {
    it('accepts identical hashes', () => {
      const hash = signPaywayQrRequest(apiKey, {
        reqTime: '20261004153000',
        merchantId: 'lw00000000',
        transactionId: 'PW261004153000-ABC123',
        amount: '129.00',
        items: '',
        firstName: '',
        lastName: '',
        email: '',
        phone: '',
        purchaseType: 'purchase',
        paymentOption: 'abapay_khqr',
        callbackUrl: '',
        returnDeeplink: '',
        currency: 'USD',
        customFields: '',
        returnParams: '',
        payout: '',
        lifetimeMinutes: 30,
        qrImageTemplate: 'template3_color',
      });

      expect(hashesMatch(hash, hash)).toBe(true);
    });

    it('rejects a different hash', () => {
      expect(hashesMatch('abc', 'abd')).toBe(false);
    });

    it('rejects hashes of different lengths instead of throwing', () => {
      // `crypto.timingSafeEqual` throws on a length mismatch, which is the kind of thing
      // that turns a rejected signature into a 500.
      expect(hashesMatch('short', 'a-much-longer-hash-value')).toBe(false);
      expect(hashesMatch('', 'x')).toBe(false);
      expect(hashesMatch('', '')).toBe(true);
    });
  });

  describe('formatPaywayAmount', () => {
    it('renders USD with the two decimals PayWay requires', () => {
      expect(formatPaywayAmount(new Prisma.Decimal('129'), 'USD')).toBe('129.00');
      expect(formatPaywayAmount(new Prisma.Decimal('0.5'), 'USD')).toBe('0.50');
    });

    it('renders KHR with no decimals', () => {
      // KHR is a whole-unit currency in PayWay's API; sending `100.00` is rejected.
      expect(formatPaywayAmount(new Prisma.Decimal('100'), 'KHR')).toBe('100');
      expect(formatPaywayAmount(new Prisma.Decimal('12345'), 'KHR')).toBe('12345');
    });

    it('rejects a fractional KHR amount instead of rounding it', () => {
      // Rounding would charge `45001` for an order that charges `45000.67`, and the
      // callback would then reject PayWay's honest total as a mismatch — a payment the
      // customer completed that the order can never be confirmed against.
      expect(() =>
        formatPaywayAmount(new Prisma.Decimal('12345.67'), 'KHR'),
      ).toThrow(/whole number/);
      expect(() => formatPaywayAmount(new Prisma.Decimal('45000.67'), 'KHR')).toThrow();
      // ...while USD keeps its cents, because it is a decimal currency.
      expect(formatPaywayAmount(new Prisma.Decimal('12345.67'), 'USD')).toBe(
        '12345.67',
      );
    });

    it('rejects a currency PayWay does not accept', () => {
      expect(() =>
        formatPaywayAmount(new Prisma.Decimal('10'), 'EUR'),
      ).toThrow(/EUR/);
    });

    it('rejects an amount below the provider minimum', () => {
      expect(() => formatPaywayAmount(new Prisma.Decimal('0.001'), 'USD')).toThrow();
      expect(() => formatPaywayAmount(new Prisma.Decimal('99'), 'KHR')).toThrow();
      expect(formatPaywayAmount(new Prisma.Decimal('0.01'), 'USD')).toBe('0.01');
      expect(formatPaywayAmount(new Prisma.Decimal('100'), 'KHR')).toBe('100');
    });

    it('refuses a non-positive amount', () => {
      expect(() => formatPaywayAmount(new Prisma.Decimal('0'), 'USD')).toThrow();
      expect(() => formatPaywayAmount(new Prisma.Decimal('-5'), 'USD')).toThrow();
    });

    it('reads a string amount without going through a float', () => {
      // `parseFloat('0.07') * 100` is 7.000000000000001 in IEEE-754. Formatting the
      // Decimal directly is the whole reason money is not a JavaScript number here.
      expect(formatPaywayAmount('0.07', 'USD')).toBe('0.07');
      expect(formatPaywayAmount('8.29', 'USD')).toBe('8.29');
    });
  });

  describe('isSupportedCurrency', () => {
    it('accepts the two currencies PayWay supports', () => {
      expect(isSupportedCurrency('USD')).toBe(true);
      expect(isSupportedCurrency('KHR')).toBe(true);
    });

    it('is case-sensitive, because PayWay is', () => {
      expect(isSupportedCurrency('usd')).toBe(false);
    });
  });

  describe('isValidPaywayTransactionId', () => {
    it('accepts the format this project generates', () => {
      expect(isValidPaywayTransactionId('PW261004153000ABC123')).toBe(true);
    });

    it('accepts the characters PayWay allows, not only our own alphabet', () => {
      // The validator answers "could this be a provider id", not "did we generate it",
      // so it must not hard-code `PW` + 12 digits + 6 upper-case characters.
      expect(isValidPaywayTransactionId('tran-1234_A')).toBe(true);
    });

    it('rejects anything PayWay would refuse', () => {
      expect(isValidPaywayTransactionId('')).toBe(false);
      expect(isValidPaywayTransactionId('has space')).toBe(false);
      expect(isValidPaywayTransactionId('a'.repeat(21))).toBe(false);
      expect(isValidPaywayTransactionId('emoji🙂')).toBe(false);
    });

    it('accepts exactly PayWay maximum length', () => {
      expect(isValidPaywayTransactionId('a'.repeat(PAYWAY_MAX_TRANSACTION_ID_LENGTH))).toBe(
        true,
      );
    });
  });

  describe('formatPaywayRequestTime', () => {
    it('renders YYYYMMDDHHMMSS in UTC', () => {
      expect(formatPaywayRequestTime(new Date('2026-10-04T15:30:07.000Z'))).toBe(
        '20261004153007',
      );
    });

    it('pads every component', () => {
      expect(formatPaywayRequestTime(new Date('2026-01-02T03:04:05.000Z'))).toBe(
        '20260102030405',
      );
    });

    it('is fourteen digits and nothing else', () => {
      expect(formatPaywayRequestTime()).toMatch(/^\d{14}$/);
    });
  });

  describe('encodePaywayBase64', () => {
    it('encodes UTF-8, not latin1', () => {
      // PayWay's own docs carry Khmer customer names. Encoding those as latin1 would
      // silently produce a different string than the provider computes, and the
      // signature would fail for every non-ASCII shopper.
      expect(encodePaywayBase64('សុភា')).toBe(
        Buffer.from('សុភា', 'utf8').toString('base64'),
      );
      expect(encodePaywayBase64('https://example.test/x')).toBe(
        'aHR0cHM6Ly9leGFtcGxlLnRlc3QveA==',
      );
    });
  });
});
