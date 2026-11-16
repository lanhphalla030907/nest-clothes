import { generateVAPIDKeys } from 'web-push';
import { readVapidSettings } from './vapid.config.js';

const SECRET_SUBJECT = 'mailto:admin@example.com';

describe('readVapidSettings', () => {
  it('accepts a complete, valid VAPID configuration', () => {
    const keys = generateVAPIDKeys();

    const settings = readVapidSettings({
      VAPID_PUBLIC_KEY: keys.publicKey,
      VAPID_PRIVATE_KEY: keys.privateKey,
      VAPID_SUBJECT: SECRET_SUBJECT,
    });

    expect(settings.configured).toBe(true);
    expect(settings.publicKey).toBe(keys.publicKey);
    expect(settings.subject).toBe(SECRET_SUBJECT);
  });

  it('accepts an https subject', () => {
    const keys = generateVAPIDKeys();

    const settings = readVapidSettings({
      VAPID_PUBLIC_KEY: keys.publicKey,
      VAPID_PRIVATE_KEY: keys.privateKey,
      VAPID_SUBJECT: 'https://example.com/vapid',
    });

    expect(settings.configured).toBe(true);
  });

  it('trims surrounding whitespace from values', () => {
    const keys = generateVAPIDKeys();

    const settings = readVapidSettings({
      VAPID_PUBLIC_KEY: ` ${keys.publicKey} `,
      VAPID_PRIVATE_KEY: ` ${keys.privateKey} `,
      VAPID_SUBJECT: ` ${SECRET_SUBJECT} `,
    });

    expect(settings.configured).toBe(true);
    expect(settings.publicKey).toBe(keys.publicKey);
  });

  it('is not configured when no values are set', () => {
    const settings = readVapidSettings({});

    expect(settings.configured).toBe(false);
    expect(settings.publicKey).toBeNull();
    expect(settings.subject).toBeNull();
  });

  it('is not configured when only the public key is set', () => {
    const keys = generateVAPIDKeys();

    const settings = readVapidSettings({
      VAPID_PUBLIC_KEY: keys.publicKey,
    });

    expect(settings.configured).toBe(false);
  });

  it('is not configured with an invalid subject', () => {
    const keys = generateVAPIDKeys();

    const settings = readVapidSettings({
      VAPID_PUBLIC_KEY: keys.publicKey,
      VAPID_PRIVATE_KEY: keys.privateKey,
      VAPID_SUBJECT: 'not-a-valid-subject',
    });

    expect(settings.configured).toBe(false);
  });

  it('is not configured with a mismatched key pair', () => {
    const keysA = generateVAPIDKeys();
    const keysB = generateVAPIDKeys();

    const settings = readVapidSettings({
      VAPID_PUBLIC_KEY: keysA.publicKey,
      VAPID_PRIVATE_KEY: keysB.privateKey,
      VAPID_SUBJECT: SECRET_SUBJECT,
    });

    expect(settings.configured).toBe(false);
  });

  it('is not configured with malformed base64url keys', () => {
    const settings = readVapidSettings({
      VAPID_PUBLIC_KEY: 'not-valid-base64url!!!',
      VAPID_PRIVATE_KEY: 'also-not-valid!!!',
      VAPID_SUBJECT: SECRET_SUBJECT,
    });

    expect(settings.configured).toBe(false);
  });

  it('freezes the settings object', () => {
    const keys = generateVAPIDKeys();

    const settings = readVapidSettings({
      VAPID_PUBLIC_KEY: keys.publicKey,
      VAPID_PRIVATE_KEY: keys.privateKey,
      VAPID_SUBJECT: SECRET_SUBJECT,
    });

    expect(Object.isFrozen(settings)).toBe(true);
  });
});
