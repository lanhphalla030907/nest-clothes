import crypto from 'node:crypto';
import { Injectable, InternalServerErrorException } from '@nestjs/common';

export interface RotationPayload {
  refreshToken: string;
  csrfToken: string;
  accessToken: string;
  expiresIn: string;
}

export interface EncryptedRotationPayload {
  ciphertext: string;
  nonce: string;
  authenticationTag: string;
  keyVersion: number;
}

interface KeyringEntry {
  keyVersion: number;
  key: Buffer;
}

@Injectable()
export class RefreshResultEncryptionService {
  private readonly entries: Map<number, Buffer>;
  private readonly activeKeyVersion: number;

  constructor() {
    const env = process.env;
    const json = env.REFRESH_RESULT_ENCRYPTION_KEYS;
    const legacyKey = env.REFRESH_RESULT_ENCRYPTION_KEY;
    const configuredVersion = Number(
      env.REFRESH_RESULT_ENCRYPTION_ACTIVE_VERSION ?? '1',
    );

    this.entries = new Map();

    if (json) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch {
        throw new InternalServerErrorException(
          'Refresh result encryption keyring is invalid',
        );
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new InternalServerErrorException(
          'Refresh result encryption keyring is invalid',
        );
      }
      for (const [versionText, encoded] of Object.entries(parsed)) {
        const version = Number(versionText);
        if (
          !Number.isInteger(version) ||
          version < 1 ||
          typeof encoded !== 'string'
        ) {
          throw new InternalServerErrorException(
            'Refresh result encryption keyring is invalid',
          );
        }
        this.entries.set(version, this.decodeKey(encoded));
      }
    } else if (legacyKey) {
      this.entries.set(1, this.decodeKey(legacyKey));
    }

    this.activeKeyVersion =
      this.entries.has(configuredVersion) ? configuredVersion : 0;
    if (
      !Number.isInteger(configuredVersion) ||
      configuredVersion < 1 ||
      this.activeKeyVersion === 0
    ) {
      throw new InternalServerErrorException(
        'Refresh result encryption active key is unavailable',
      );
    }
  }

  encrypt(
    payload: RotationPayload,
    aad: Buffer,
  ): EncryptedRotationPayload {
    const key = this.requireKey(this.activeKeyVersion);
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad, { plaintextLength: Buffer.byteLength(JSON.stringify(payload)) });
    const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authenticationTag = cipher.getAuthTag();

    return {
      ciphertext: ciphertext.toString('base64'),
      nonce: nonce.toString('base64'),
      authenticationTag: authenticationTag.toString('base64'),
      keyVersion: this.activeKeyVersion,
    };
  }

  decrypt(
    ciphertext: string,
    nonce: string,
    authenticationTag: string,
    keyVersion: number,
    aad: Buffer,
  ): RotationPayload {
    const key = this.requireKey(keyVersion);
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      this.decodeBinary(nonce),
    );
    decipher.setAAD(aad, {
      plaintextLength: this.decodeBinary(ciphertext).length,
    });
    decipher.setAuthTag(this.decodeBinary(authenticationTag));

    try {
      const plaintext = Buffer.concat([
        decipher.update(this.decodeBinary(ciphertext)),
        decipher.final(),
      ]);
      const payload: unknown = JSON.parse(plaintext.toString('utf8'));
      if (
        typeof payload !== 'object' ||
        payload === null ||
        typeof (payload as { refreshToken?: unknown }).refreshToken !== 'string' ||
        typeof (payload as { csrfToken?: unknown }).csrfToken !== 'string' ||
        typeof (payload as { accessToken?: unknown }).accessToken !== 'string' ||
        typeof (payload as { expiresIn?: unknown }).expiresIn !== 'string'
      ) {
        throw new Error('invalid payload');
      }
      return payload as RotationPayload;
    } catch {
      throw new InternalServerErrorException(
        'Refresh rotation result authentication failed',
      );
    }
  }

  reencrypt(
    ciphertext: string,
    nonce: string,
    authenticationTag: string,
    keyVersion: number,
    aad: Buffer,
  ): EncryptedRotationPayload {
    const payload = this.decrypt(
      ciphertext,
      nonce,
      authenticationTag,
      keyVersion,
      aad,
    );
    return this.encrypt(payload, aad);
  }

  private requireKey(version: number): Buffer {
    const key = this.entries.get(version);
    if (!key) {
      throw new InternalServerErrorException(
        'Refresh result encryption key version is unavailable',
      );
    }
    return key;
  }

  private decodeKey(encoded: string): Buffer {
    let key: Buffer;
    if (/^[A-Fa-f0-9]{64}$/.test(encoded)) {
      key = Buffer.from(encoded, 'hex');
    } else {
      key = Buffer.from(encoded, 'base64');
      if (key.length !== 32) {
        key = Buffer.from(encoded, 'base64url');
      }
    }
    if (key.length !== 32) {
      throw new InternalServerErrorException(
        'Refresh result encryption key must be 32 bytes',
      );
    }
    return key;
  }

  private decodeBinary(value: string): Buffer {
    return Buffer.from(value, 'base64');
  }
}
