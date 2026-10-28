import { JwtService } from '@nestjs/jwt';
import { inspect as utilInspect } from 'node:util';
import {
  DEFAULT_JWT_AUDIENCE,
  DEFAULT_JWT_EXPIRES_IN,
  DEFAULT_JWT_ISSUER,
  JWT_ENV_VARS,
} from './jwt.constants.js';
import { MIN_JWT_SECRET_LENGTH, readJwtSettings } from './jwt.config.js';
import { AccessTokenService } from './access-token.service.js';
import { Role } from '../../generated/prisma/enums.js';

const SECRET = 'a-signing-key-that-is-long-enough-for-the-test';
const USER = {
  id: 'a1b2c3d4-e5f6-4f70-8a9b-0c1d2e3f4a5b',
  email: 'ada@example.test',
  role: Role.CUSTOMER,
};

/**
 * The signing key is the one piece of configuration whose failure mode is silent: a
 * missing or short key either refuses to start or, worse, produces tokens an attacker
 * can forge offline. These tests cover the refusal, and — just as important — that a
 * refusal never echoes the value it rejected, since error messages end up in logs.
 */
describe('readJwtSettings', () => {
  it('accepts a complete environment', () => {
    const settings = readJwtSettings({
      [JWT_ENV_VARS.secret]: SECRET,
      [JWT_ENV_VARS.expiresIn]: '30m',
      [JWT_ENV_VARS.issuer]: 'api',
      [JWT_ENV_VARS.audience]: 'clients',
    });

    expect(settings).toEqual({
      secret: SECRET,
      expiresIn: '30m',
      issuer: 'api',
      audience: 'clients',
    });
  });

  it('applies the documented defaults when only the secret is set', () => {
    const settings = readJwtSettings({ [JWT_ENV_VARS.secret]: SECRET });

    expect(settings.expiresIn).toBe(DEFAULT_JWT_EXPIRES_IN);
    expect(settings.issuer).toBe(DEFAULT_JWT_ISSUER);
    expect(settings.audience).toBe(DEFAULT_JWT_AUDIENCE);
  });

  it('trims surrounding whitespace, which a .env line often carries', () => {
    const settings = readJwtSettings({
      [JWT_ENV_VARS.secret]: `  ${SECRET}  `,
    });

    expect(settings.secret).toBe(SECRET);
  });

  it('refuses to start with no signing key', () => {
    expect(() => readJwtSettings({})).toThrow(JWT_ENV_VARS.secret);
  });

  it('refuses a blank signing key rather than treating it as absent-but-fine', () => {
    expect(() => readJwtSettings({ [JWT_ENV_VARS.secret]: '   ' })).toThrow(
      JWT_ENV_VARS.secret,
    );
  });

  it('refuses a signing key below the minimum length', () => {
    const short = 'x'.repeat(MIN_JWT_SECRET_LENGTH - 1);

    expect(() => readJwtSettings({ [JWT_ENV_VARS.secret]: short })).toThrow(
      JWT_ENV_VARS.secret,
    );
    expect(() =>
      readJwtSettings({ [JWT_ENV_VARS.secret]: 'x'.repeat(MIN_JWT_SECRET_LENGTH) }),
    ).not.toThrow();
  });

  it('refuses a lifetime that is not a duration', () => {
    expect(() =>
      readJwtSettings({
        [JWT_ENV_VARS.secret]: SECRET,
        [JWT_ENV_VARS.expiresIn]: 'soon',
      }),
    ).toThrow(JWT_ENV_VARS.expiresIn);
  });

  it.each(['900', '15m', '1h', '2 d', '30s', '500ms'])(
    'accepts the duration %s',
    (expiresIn) => {
      expect(() =>
        readJwtSettings({
          [JWT_ENV_VARS.secret]: SECRET,
          [JWT_ENV_VARS.expiresIn]: expiresIn,
        }),
      ).not.toThrow();
    },
  );

  it('names every unusable variable at once, so one restart is enough', () => {
    let message = '';
    try {
      readJwtSettings({ [JWT_ENV_VARS.expiresIn]: 'whenever' });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain(JWT_ENV_VARS.secret);
    expect(message).toContain(JWT_ENV_VARS.expiresIn);
  });

  it('never repeats a value, not even the one it accepted', () => {
    let message = '';
    try {
      readJwtSettings({ [JWT_ENV_VARS.secret]: 'too-short' });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).not.toContain('too-short');
    expect(message).not.toContain(SECRET);
  });

  it('returns a frozen object, so a caller cannot rewrite the secret in place', () => {
    const settings = readJwtSettings({ [JWT_ENV_VARS.secret]: SECRET });

    expect(Object.isFrozen(settings)).toBe(true);
  });
});

describe('AccessTokenService', () => {
  const serviceFor = (settings = readJwtSettings({ [JWT_ENV_VARS.secret]: SECRET })) =>
    new AccessTokenService(new JwtService({}), settings);

  it('issues a token whose subject is the user id, and carries no password', async () => {
    const service = serviceFor();
    const token = service.sign(USER);
    const payload = await service.verify(token);

    expect(payload.sub).toBe(USER.id);
    expect(payload.role).toBe(Role.CUSTOMER);
    expect(JSON.stringify(payload)).not.toContain('passwordHash');
  });

  it('round-trips its own token', async () => {
    const service = serviceFor();

    await expect(service.verify(service.sign(USER))).resolves.toMatchObject({
      sub: USER.id,
    });
  });

  it('refuses a token signed with a different key', async () => {
    const other = new AccessTokenService(
      new JwtService({}),
      readJwtSettings({ [JWT_ENV_VARS.secret]: 'a-completely-different-key-value' }),
    );

    await expect(serviceFor().verify(other.sign(USER))).rejects.toThrow();
  });

  it('refuses a token minted for another audience or issuer', async () => {
    const service = serviceFor();
    const foreign = new JwtService({}).sign(
      { sub: USER.id, email: USER.email, role: USER.role },
      {
        secret: SECRET,
        expiresIn: '15m',
        issuer: DEFAULT_JWT_ISSUER,
        audience: 'someone-else',
        algorithm: 'HS256',
      },
    );

    await expect(service.verify(foreign)).rejects.toThrow();
  });

  it('refuses an unsigned token, which would otherwise parse as claims', async () => {
    const unsigned = Buffer.from(
      JSON.stringify({ sub: USER.id, email: USER.email, role: Role.ADMIN }),
    ).toString('base64url');

    await expect(serviceFor().verify(unsigned)).rejects.toThrow();
  });

  it('refuses a token carrying no subject', async () => {
    const subjectless = new JwtService({}).sign(
      { email: USER.email, role: USER.role },
      {
        secret: SECRET,
        expiresIn: '15m',
        issuer: DEFAULT_JWT_ISSUER,
        audience: DEFAULT_JWT_AUDIENCE,
        algorithm: 'HS256',
      },
    );

    await expect(serviceFor().verify(subjectless)).rejects.toThrow(
      'Access token payload is not usable',
    );
  });

  it('refuses a token whose role is not one this application issues', async () => {
    const superuser = new JwtService({}).sign(
      { sub: USER.id, email: USER.email, role: 'SUPERUSER' },
      {
        secret: SECRET,
        expiresIn: '15m',
        issuer: DEFAULT_JWT_ISSUER,
        audience: DEFAULT_JWT_AUDIENCE,
        algorithm: 'HS256',
      },
    );

    await expect(serviceFor().verify(superuser)).rejects.toThrow(
      'Access token payload is not usable',
    );
  });

  it('exposes the configured lifetime and never the secret', () => {
    const service = serviceFor(
      readJwtSettings({
        [JWT_ENV_VARS.secret]: SECRET,
        [JWT_ENV_VARS.expiresIn]: '45m',
      }),
    );

    expect(service.expiresIn).toBe('45m');
    expect(JSON.stringify(service)).not.toContain(SECRET);
    expect(String(service)).not.toContain(SECRET);
    expect(utilInspect(service)).not.toContain(SECRET);
  });
});