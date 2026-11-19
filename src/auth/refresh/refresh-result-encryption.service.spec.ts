import { RefreshResultEncryptionService } from './refresh-result-encryption.service.js';

describe('RefreshResultEncryptionService', () => {
  const previousKeyring = process.env.REFRESH_RESULT_ENCRYPTION_KEYS;
  const previousActive = process.env.REFRESH_RESULT_ENCRYPTION_ACTIVE_VERSION;

  beforeEach(() => {
    process.env.REFRESH_RESULT_ENCRYPTION_KEYS = JSON.stringify({
      '1': Buffer.alloc(32, 1).toString('base64'),
      '2': Buffer.alloc(32, 2).toString('base64'),
    });
    process.env.REFRESH_RESULT_ENCRYPTION_ACTIVE_VERSION = '2';
  });

  afterAll(() => {
    if (previousKeyring === undefined) {
      delete process.env.REFRESH_RESULT_ENCRYPTION_KEYS;
    } else {
      process.env.REFRESH_RESULT_ENCRYPTION_KEYS = previousKeyring;
    }
    if (previousActive === undefined) {
      delete process.env.REFRESH_RESULT_ENCRYPTION_ACTIVE_VERSION;
    } else {
      process.env.REFRESH_RESULT_ENCRYPTION_ACTIVE_VERSION = previousActive;
    }
  });

  it('encrypts with AES-GCM and authenticates the bound AAD', () => {
    const service = new RefreshResultEncryptionService();
    const aad = Buffer.from('operation-bound-aad');
    const encrypted = service.encrypt(
      {
        refreshToken: 'raw-refresh',
        csrfToken: 'raw-csrf',
        accessToken: 'raw-access',
        expiresIn: '15m',
      },
      aad,
    );

    expect(encrypted.keyVersion).toBe(2);
    expect(Buffer.from(encrypted.nonce, 'base64')).toHaveLength(12);
    expect(encrypted.ciphertext).not.toContain('raw-refresh');

    expect(
      service.decrypt(
        encrypted.ciphertext,
        encrypted.nonce,
        encrypted.authenticationTag,
        encrypted.keyVersion,
        aad,
      ).refreshToken,
    ).toBe('raw-refresh');

    expect(() =>
      service.decrypt(
        encrypted.ciphertext,
        encrypted.nonce,
        encrypted.authenticationTag,
        encrypted.keyVersion,
        Buffer.from('wrong-aad'),
      ),
    ).toThrow();
  });

  it('supports decrypting and re-encrypting a payload under another key version', () => {
    process.env.REFRESH_RESULT_ENCRYPTION_ACTIVE_VERSION = '1';
    const oldService = new RefreshResultEncryptionService();
    const aad = Buffer.from('key-version-aad');
    const oldEncrypted = oldService.encrypt(
      {
        refreshToken: 'raw-refresh',
        csrfToken: 'raw-csrf',
        accessToken: 'raw-access',
        expiresIn: '15m',
      },
      aad,
    );

    process.env.REFRESH_RESULT_ENCRYPTION_ACTIVE_VERSION = '2';
    const rotatedService = new RefreshResultEncryptionService();
    const reencrypted = rotatedService.reencrypt(
      oldEncrypted.ciphertext,
      oldEncrypted.nonce,
      oldEncrypted.authenticationTag,
      oldEncrypted.keyVersion,
      aad,
    );

    expect(reencrypted.keyVersion).toBe(2);
    expect(
      rotatedService.decrypt(
        reencrypted.ciphertext,
        reencrypted.nonce,
        reencrypted.authenticationTag,
        reencrypted.keyVersion,
        aad,
      ).refreshToken,
    ).toBe('raw-refresh');
  });

  it('rejects construction when the active key is unavailable', () => {
    process.env.REFRESH_RESULT_ENCRYPTION_ACTIVE_VERSION = '99';
    expect(() => new RefreshResultEncryptionService()).toThrow(
      'Refresh result encryption active key is unavailable',
    );
  });
});
