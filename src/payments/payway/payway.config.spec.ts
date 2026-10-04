import { PAYWAY_SANDBOX_BASE_URL } from './payway.constants.js';
import { isPaywayConfigured, readPaywayConfig } from './payway.config.js';

/**
 * Two properties matter here and neither is obvious from the code.
 *
 * **The application must boot without PayWay credentials.** Every CI run, every fresh
 * clone and a cart-only deployment has none, so `readPaywayConfig` may never throw —
 * the opposite of the Cloudinary config beside it, deliberately.
 *
 * **It may never echo a value.** An exception or a log line about a missing credential
 * ends up in an error tracker, so the only safe content is the variable's *name*. These
 * tests hold the config object to that by stringifying it and searching for the secret.
 */
describe('readPaywayConfig', () => {
  const merchantId = 'lw00000000';
  const apiKey = 'super-secret-api-key-value';
  const callbackUrl = 'https://example.test/payments/aba-payway/callback';

  const completeEnv = {
    PAYWAY_MERCHANT_ID: merchantId,
    PAYWAY_API_KEY: apiKey,
    PAYWAY_CALLBACK_URL: callbackUrl,
  } as NodeJS.ProcessEnv;

  describe('a complete configuration', () => {
    it('is reported as configured', () => {
      const config = readPaywayConfig(completeEnv);

      expect(config.configured).toBe(true);
      expect(config.missing).toEqual([]);
    });

    it('exposes the validated settings', () => {
      const config = readPaywayConfig(completeEnv);

      expect(config.configured).toBe(true);

      if (!config.configured) {
        throw new Error('expected a configured result');
      }

      expect(config.settings.merchantId).toBe(merchantId);
      expect(config.settings.callbackUrl).toBe(callbackUrl);
      expect(config.settings.baseUrl).toBe(PAYWAY_SANDBOX_BASE_URL);
    });

    it('trims surrounding whitespace, which is a common .env paste artefact', () => {
      const config = readPaywayConfig({
        ...completeEnv,
        PAYWAY_MERCHANT_ID: `  ${merchantId}  `,
      });

      expect(config.configured).toBe(true);

      if (!config.configured) {
        throw new Error('expected a configured result');
      }

      expect(config.settings.merchantId).toBe(merchantId);
    });

    it('is frozen, so no consumer can mutate a validated credential', () => {
      const config = readPaywayConfig(completeEnv);

      expect(Object.isFrozen(config)).toBe(true);

      if (!config.configured) {
        throw new Error('expected a configured result');
      }

      expect(Object.isFrozen(config.settings)).toBe(true);
      expect(() => {
        (config.settings as { apiKey: string }).apiKey = 'overwritten';
      }).toThrow();
    });
  });

  describe('an incomplete configuration', () => {
    it('never throws when everything is absent', () => {
      expect(() => readPaywayConfig({})).not.toThrow();
    });

    it('names each missing variable', () => {
      const config = readPaywayConfig({});

      expect(config.configured).toBe(false);
      expect([...config.missing].sort()).toEqual([
        'PAYWAY_API_KEY',
        'PAYWAY_CALLBACK_URL',
        'PAYWAY_MERCHANT_ID',
      ]);
    });

    it('treats a blank value as missing rather than as a value', () => {
      const config = readPaywayConfig({ ...completeEnv, PAYWAY_API_KEY: '   ' });

      expect(config.configured).toBe(false);
      expect(config.missing).toContain('PAYWAY_API_KEY');
    });

    it('carries no settings at all, so a blank credential cannot be used by accident', () => {
      // The whole point of the union: the unconfigured variant has no `settings`
      // property, so there is nothing to sign a request with.
      const config = readPaywayConfig({});

      expect(config.settings).toBeUndefined();
      expect(JSON.stringify(config)).not.toContain('merchantId');
    });

    it('reports only the variable that is missing', () => {
      const config = readPaywayConfig({
        ...completeEnv,
        PAYWAY_MERCHANT_ID: undefined,
      });

      expect(config.missing).toEqual(['PAYWAY_MERCHANT_ID']);
    });

    it('never contains a credential value in any form', () => {
      // A present-but-incomplete configuration: the merchant id and callback URL are
      // valid, so they are *not* listed as missing — and must not leak into the object
      // either. If they did, an error tracker holding this config would hold the
      // credentials too.
      const config = readPaywayConfig({
        PAYWAY_MERCHANT_ID: merchantId,
        PAYWAY_CALLBACK_URL: callbackUrl,
      });

      const serialised = JSON.stringify(config);

      expect(config.configured).toBe(false);
      expect(config.missing).toEqual(['PAYWAY_API_KEY']);
      expect(serialised).not.toContain(merchantId);
      expect(serialised).not.toContain(callbackUrl);
      // The name is expected and useful; the value is the thing that must never appear.
      expect(serialised).toContain('PAYWAY_API_KEY');
    });

    it('does not leak the API key when some other variable is the missing one', () => {
      // The key is present and valid here, so the configuration fails on the callback
      // URL. The object must then contain no trace of the key at all.
      const config = readPaywayConfig({
        PAYWAY_MERCHANT_ID: merchantId,
        PAYWAY_API_KEY: apiKey,
      });

      const serialised = JSON.stringify(config);

      expect(config.configured).toBe(false);
      expect(config.missing).toEqual(['PAYWAY_CALLBACK_URL']);
      expect(serialised).not.toContain(apiKey);
      expect(serialised).not.toContain(apiKey.slice(0, 6));
    });
  });

  describe('PAYWAY_BASE_URL', () => {
    it('defaults to the sandbox when absent', () => {
      const config = readPaywayConfig(completeEnv);

      expect(config.configured).toBe(true);
      expect(config.missing).toEqual([]);

      if (!config.configured) {
        throw new Error('expected a configured result');
      }

      expect(config.settings.baseUrl).toBe(PAYWAY_SANDBOX_BASE_URL);
    });

    it('is not reported missing when it is merely absent', () => {
      // The bug this pins down: treating the default as a requirement would make every
      // unconfigured deployment list a variable it does not need.
      expect(readPaywayConfig(completeEnv).missing).not.toContain('PAYWAY_BASE_URL');
    });

    it('accepts an explicit https origin', () => {
      const config = readPaywayConfig({
        ...completeEnv,
        PAYWAY_BASE_URL: 'https://checkout-sandbox.payway.com.kh',
      });

      expect(config.configured).toBe(true);

      if (!config.configured) {
        throw new Error('expected a configured result');
      }

      expect(config.settings.baseUrl).toBe('https://checkout-sandbox.payway.com.kh');
    });

    it('reduces a base URL with a path to its origin', () => {
      // Otherwise the documented `/api/...` suffix would be appended to a path and
      // produce a 404 nobody could explain.
      const config = readPaywayConfig({
        ...completeEnv,
        PAYWAY_BASE_URL: 'https://payway.test/gateway/',
      });

      if (!config.configured) {
        throw new Error('expected a configured result');
      }

      expect(config.settings.baseUrl).toBe('https://payway.test');
    });

    it('rejects plain http, which would put a valid signature on the wire in clear', () => {
      const config = readPaywayConfig({
        ...completeEnv,
        PAYWAY_BASE_URL: 'http://payway.test',
      });

      expect(config.configured).toBe(false);
      expect(config.missing).toContain('PAYWAY_BASE_URL');
    });

    it('rejects a non-HTTP scheme rather than pattern-matching a prefix', () => {
      const config = readPaywayConfig({
        ...completeEnv,
        PAYWAY_BASE_URL: 'javascript:alert(1)',
      });

      expect(config.configured).toBe(false);
      expect(config.missing).toContain('PAYWAY_BASE_URL');
    });

    it('reports a present-but-unusable base URL as missing', () => {
      // Falling back to the sandbox after somebody asked for somewhere else would send
      // live payment traffic to a test host.
      const config = readPaywayConfig({ ...completeEnv, PAYWAY_BASE_URL: 'not-a-url' });

      expect(config.missing).toContain('PAYWAY_BASE_URL');
    });

    it('reports a blank base URL as missing, not as absent', () => {
      const config = readPaywayConfig({ ...completeEnv, PAYWAY_BASE_URL: '  ' });

      expect(config.missing).toContain('PAYWAY_BASE_URL');
    });
  });

  describe('PAYWAY_CALLBACK_URL', () => {
    it('must be absolute https', () => {
      const config = readPaywayConfig({
        ...completeEnv,
        PAYWAY_CALLBACK_URL: 'http://localhost:3000/payments/aba-payway/callback',
      });

      expect(config.configured).toBe(false);
      expect(config.missing).toContain('PAYWAY_CALLBACK_URL');
    });

    it('must not be a relative path', () => {
      const config = readPaywayConfig({
        ...completeEnv,
        PAYWAY_CALLBACK_URL: '/payments/aba-payway/callback',
      });

      expect(config.configured).toBe(false);
      expect(config.missing).toContain('PAYWAY_CALLBACK_URL');
    });

    it('keeps the path, since PayWay posts to the whole URL', () => {
      const config = readPaywayConfig({
        ...completeEnv,
        PAYWAY_CALLBACK_URL: 'https://shop.example/api/payments/aba-payway/callback',
      });

      if (!config.configured) {
        throw new Error('expected a configured result');
      }

      expect(config.settings.callbackUrl).toBe(
        'https://shop.example/api/payments/aba-payway/callback',
      );
    });
  });

  describe('isPaywayConfigured', () => {
    it('narrows to the configured variant', () => {
      const config = readPaywayConfig(completeEnv);

      expect(isPaywayConfigured(config)).toBe(true);

      if (!isPaywayConfigured(config)) {
        throw new Error('expected narrowing to succeed');
      }

      expect(config.settings.apiKey).toBe(apiKey);
    });

    it('refuses to narrow an unconfigured one', () => {
      expect(isPaywayConfigured(readPaywayConfig({}))).toBe(false);
    });

    it('returns undefined settings when unconfigured', () => {
      expect(isPaywayConfigured(readPaywayConfig({}), 'settings')).toBeUndefined();
    });

    it('returns the settings when configured', () => {
      const settings = isPaywayConfigured(readPaywayConfig(completeEnv), 'settings');

      expect(settings?.merchantId).toBe(merchantId);
    });
  });

  it('reads process.env by default, so the module needs no argument in production', () => {
    // A smoke check on the default parameter only: it must not throw with whatever the
    // test runner's environment happens to hold.
    expect(() => readPaywayConfig()).not.toThrow();
  });
});
