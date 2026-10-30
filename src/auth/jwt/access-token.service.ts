import { Inject, Injectable } from '@nestjs/common';
import type { JwtSignOptions } from '@nestjs/jwt';
import { JwtService } from '@nestjs/jwt';
import { Role } from '../../generated/prisma/enums.js';
import type { JwtSettings } from './jwt.config.js';
import { JWT_SETTINGS } from './jwt.constants.js';

/**
 * `expiresIn` as the JWT library types it.
 *
 * The library models a duration as either a number of seconds or a template-literal type
 * such as `` `${number}h` ``, which a validated runtime string cannot satisfy
 * statically. `readJwtSettings` already rejects anything that is not a duration, so the
 * cast is a narrowing the compiler cannot see — and it is confined to this one place
 * rather than sprinkled through every call.
 */
type ExpiresIn = NonNullable<JwtSignOptions['expiresIn']>;

/**
 * Claims this application puts in an access token.
 *
 * `sub` is the only claim that identifies anybody: it is the user's id, and it is the
 * one the guard turns into a database read. `email` and `role` are conveniences for the
 * token's own contents — the guard deliberately re-reads the role from the database
 * rather than trusting the claim, so revoking an admin takes effect immediately instead
 * of whenever their token happens to expire.
 */
export interface AccessTokenPayload {
  sub: string;
  email: string;
  role: Role;
}

/**
 * Issues and verifies access tokens.
 *
 * The only place in the application that touches the signing secret. Everything else —
 * login, the guard, `GET /auth/me` — goes through this service, so there is one place
 * to audit for "is the key ever logged, returned, or passed somewhere it could be".
 */
@Injectable()
export class AccessTokenService {
  /**
   * The resolved settings, held in a private field rather than a plain property.
   *
   * `#settings` rather than `private readonly settings` for one reason: a normal
   * property is *enumerable*, so `JSON.stringify` of this provider — a debug log, an
   * error report, a test snapshot — would carry the signing key out of the process. A
   * private field is invisible to `JSON.stringify`, `Object.keys` and
   * `util.inspect`, so the key cannot leave this way by accident. TypeScript's `private`
   * keyword gives the same compile-time error on direct access but does nothing at
   * runtime.
   */
  readonly #settings: JwtSettings;

  constructor(
    private readonly jwtService: JwtService,
    @Inject(JWT_SETTINGS) settings: JwtSettings,
  ) {
    this.#settings = settings;
  }

  /** Signs an access token for `user`. The secret is never part of the result. */
  sign(user: { id: string; email: string; role: Role }): string {
    return this.jwtService.sign(
      { sub: user.id, email: user.email, role: user.role },
      {
        secret: this.#settings.secret,
        expiresIn: this.#settings.expiresIn as ExpiresIn,
        issuer: this.#settings.issuer,
        audience: this.#settings.audience,
        algorithm: 'HS256',
      },
    );
  }

  /**
   * Verifies a token and returns its claims.
   *
   * `jsonwebtoken` enforces the signature, `exp`, `nbf`, `iss` and `aud` here, and
   * rejects an expired token with `TokenExpiredError` and a malformed one with
   * `JsonWebTokenError`. Both are turned into the same opaque failure by the caller, so
   * a client learns nothing about *why* a token was refused.
   *
   * @throws whatever `JwtService.verifyAsync` throws — never swallowed, so an expired
   * token cannot be mistaken for a valid one.
   */
  async verify(token: string): Promise<AccessTokenPayload> {
    const payload = await this.jwtService.verifyAsync<AccessTokenPayload>(token, {
      secret: this.#settings.secret,
      issuer: this.#settings.issuer,
      audience: this.#settings.audience,
      algorithms: ['HS256'],
    });

    if (!isAccessTokenPayload(payload)) {
      throw new Error('Access token payload is not usable');
    }

    return payload;
  }

  /** The configured lifetime, returned to the client so it can schedule a refresh. */
  get expiresIn(): string {
    return this.#settings.expiresIn;
  }
}

/**
 * Whether a decoded token carries the claims this application depends on.
 *
 * A signature alone is not enough: a token signed with the right key but issued by
 * something else — or by an older version of this service — could omit `sub`, and
 * treating that as an identity would attach `undefined` to `req.user`.
 */
function isAccessTokenPayload(payload: unknown): payload is AccessTokenPayload {
  if (typeof payload !== 'object' || payload === null) {
    return false;
  }

  const candidate = payload as Partial<AccessTokenPayload>;

  return (
    typeof candidate.sub === 'string' &&
    candidate.sub.length > 0 &&
    typeof candidate.email === 'string' &&
    (candidate.role === Role.CUSTOMER ||
      candidate.role === Role.ADMIN ||
      candidate.role === Role.DELIVERY_MANAGER ||
      candidate.role === Role.DELIVERY_STAFF)
  );
}
