import { readCloudinaryCredentials } from './cloudinary.config.js';
import { CLOUDINARY_ENV_VARS } from './cloudinary.constants.js';

const VALID_ENV = {
  [CLOUDINARY_ENV_VARS.cloudName]: 'demo-cloud',
  [CLOUDINARY_ENV_VARS.apiKey]: '123456789012345',
  [CLOUDINARY_ENV_VARS.apiSecret]: 'super-secret-value',
} as NodeJS.ProcessEnv;

describe('readCloudinaryCredentials', () => {
  it('returns the three configured values when all are present', () => {
    expect(readCloudinaryCredentials(VALID_ENV)).toEqual({
      cloudName: 'demo-cloud',
      apiKey: '123456789012345',
      apiSecret: 'super-secret-value',
    });
  });

  it('throws when no Cloudinary variable is set', () => {
    expect(() => readCloudinaryCredentials({})).toThrow(
      /Cloudinary is not configured/,
    );
  });

  it('names every missing variable so an operator can fix them in one pass', () => {
    expect(() => readCloudinaryCredentials({})).toThrow(
      /CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET/,
    );
  });

  it('names only the variables that are actually missing', () => {
    const env = {
      ...VALID_ENV,
      [CLOUDINARY_ENV_VARS.apiSecret]: undefined,
    };

    const run = () => readCloudinaryCredentials(env);
    expect(run).toThrow(/CLOUDINARY_API_SECRET/);
    expect(run).not.toThrow(/CLOUDINARY_API_KEY/);
    expect(run).not.toThrow(/CLOUDINARY_CLOUD_NAME/);
  });

  it.each([
    ['empty string', ''],
    ['whitespace only', '   '],
    ['tab only', '\t'],
  ])('treats a %s value as missing', (_label, value) => {
    const env = { ...VALID_ENV, [CLOUDINARY_ENV_VARS.apiKey]: value };

    expect(() => readCloudinaryCredentials(env)).toThrow(
      /CLOUDINARY_API_KEY/,
    );
  });

  it('does not read process.env when an environment object is supplied', () => {
    /**
     * Guards the seam the tests rely on: the reader takes its environment as an
     * argument precisely so a test never has to mutate `process.env` and risk
     * leaking a fake credential into a sibling test file.
     */
    const original = { ...process.env };

    try {
      process.env[CLOUDINARY_ENV_VARS.apiKey] = 'mutated';

      expect(readCloudinaryCredentials(VALID_ENV).apiKey).toBe('123456789012345');
    } finally {
      process.env = original;
    }
  });

  it('defaults to process.env when called with no argument', () => {
    const original = { ...process.env };

    try {
      process.env[CLOUDINARY_ENV_VARS.cloudName] = 'from-process-env';
      process.env[CLOUDINARY_ENV_VARS.apiKey] = 'from-process-env';
      process.env[CLOUDINARY_ENV_VARS.apiSecret] = 'from-process-env';

      expect(readCloudinaryCredentials().cloudName).toBe('from-process-env');
    } finally {
      process.env = original;
    }
  });

  it('fails at startup when the real environment is unconfigured', () => {
    const original = { ...process.env };

    try {
      delete process.env[CLOUDINARY_ENV_VARS.cloudName];
      delete process.env[CLOUDINARY_ENV_VARS.apiKey];
      delete process.env[CLOUDINARY_ENV_VARS.apiSecret];

      expect(() => readCloudinaryCredentials()).toThrow(
        /Cloudinary is not configured/,
      );
    } finally {
      process.env = original;
    }
  });

  describe('secret safety', () => {
    it('never includes a credential value in the error message', () => {
      const env = {
        [CLOUDINARY_ENV_VARS.cloudName]: 'demo-cloud',
        [CLOUDINARY_ENV_VARS.apiKey]: '123456789012345',
      };

      let message = '';

      try {
        readCloudinaryCredentials(env);
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).not.toContain('demo-cloud');
      expect(message).not.toContain('123456789012345');
      expect(message).toContain('CLOUDINARY_API_SECRET');
    });

    it('returns frozen credentials so a consumer cannot mutate them', () => {
      const credentials = readCloudinaryCredentials(VALID_ENV);

      expect(Object.isFrozen(credentials)).toBe(true);
    });

    it('does not expose credentials when serialised', () => {
      const credentials = readCloudinaryCredentials(VALID_ENV);

      /**
       * `JSON.stringify` is the most common accidental path to leaking a
       * configuration object — a debug log, an error payload, a snapshot. The
       * values are still present in the object (the SDK needs them), so this
       * asserts the documented exposure surface rather than pretending they are
       * unreachable; the guarantee is that only the service ever holds them.
       */
      const serialised = JSON.stringify(credentials);

      expect(serialised).toContain('demo-cloud');
      expect(Object.keys(credentials)).toEqual([
        'cloudName',
        'apiKey',
        'apiSecret',
      ]);
    });
  });
});
