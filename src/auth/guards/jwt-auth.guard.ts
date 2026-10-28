import {
  CanActivate,
  type ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ACTIVE_USER_STATUS } from '../../common/constants/user-status.constants.js';
import { UsersRepository } from '../../users/repositories/users.repository.js';
import { AccessTokenService } from '../jwt/access-token.service.js';
import type { AuthenticatedRequest } from '../types/authenticated-request.js';

/**
 * One message for every authentication failure.
 *
 * A missing token, a malformed one, an expired one, a bad signature and a token for a
 * user who no longer exists are all the same 401 with the same body. Distinguishing them
 * would tell an attacker whether a token was ever valid — which is information about the
 * system that costs nothing to withhold.
 */
export const UNAUTHENTICATED_MESSAGE = 'Unauthorized';

const BEARER_PREFIX = 'bearer ';

/**
 * Turns a verified access token into a request-scoped identity.
 *
 * ## Why the user is re-read from the database
 *
 * The token's claims prove *who signed in*, not *who is still allowed in*. Trusting the
 * claims for everything would mean a token issued before an account was suspended, had
 * its role changed, or was deleted stayed valid until it expired — up to the full
 * lifetime, with no way to cut it short. So the claims are used only to identify the
 * user; the authoritative role and status are the ones in the database row.
 *
 * That also means a token minted for a deleted user is a 401 rather than a request
 * acting on a row that no longer exists.
 *
 * ## Why this replaces the `X-User-Id` header outright
 *
 * The header was a *claim*: any caller who knew a UUID could send it and be believed.
 * There is no fallback to it here — a request with no valid `Authorization` header is a
 * 401 even if it carries `X-User-Id`, which is what stops the old mechanism from
 * outliving its replacement.
 *
 * ## Failures are never downgraded to a success
 *
 * Only two things end in `true`: a token that verifies *and* names a real, active user.
 * An expired token, a malformed one, a bad signature, a wrong issuer or audience, an
 * unexpected algorithm, and a `sub` that is not a UUID are all 401s.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(
    private readonly accessTokenService: AccessTokenService,
    private readonly usersRepository: UsersRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractBearerToken(request);

    if (token === null) {
      throw new UnauthorizedException(UNAUTHENTICATED_MESSAGE);
    }

    const payload = await this.verify(token);

    const user = await this.usersRepository.findById(payload.sub);

    if (user === null || user.status !== ACTIVE_USER_STATUS) {
      throw new UnauthorizedException(UNAUTHENTICATED_MESSAGE);
    }

    request.user = { id: user.id, email: user.email, role: user.role };

    return true;
  }

  /**
   * Reads the bearer token from the `Authorization` header.
   *
   * `null` for anything that is not exactly `Bearer <token>`, including an absent
   * header, a different scheme and a header with extra parts. Being strict here is what
   * stops a second scheme — or a proxy-injected header — from being interpreted as a
   * credential.
   */
  private extractBearerToken(
    request: Partial<Pick<AuthenticatedRequest, 'headers'>>,
  ): string | null {
    const header = request.headers?.['authorization'];

    const value = Array.isArray(header) ? header[0] : header;

    if (typeof value !== 'string' || !value.toLowerCase().startsWith(BEARER_PREFIX)) {
      return null;
    }

    const token = value.slice(BEARER_PREFIX.length).trim();

    return token.length === 0 ? null : token;
  }

  /**
   * Verifies the token, mapping every rejection reason to the same 401.
   *
   * The underlying error's *name* is logged and nothing else — no token, no signature, no
   * claim values. `TokenExpiredError`, `JsonWebTokenError` and `NotBeforeError` are all
   * expected traffic from a client whose token lapsed, so this is not an error worth
   * escalating; it is recorded at debug level to stay out of production logs.
   */
  private async verify(token: string) {
    try {
      return await this.accessTokenService.verify(token);
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'UnknownError';

      this.logger.debug(`Access token rejected: ${reason}`);

      throw new UnauthorizedException(UNAUTHENTICATED_MESSAGE);
    }
  }
}
