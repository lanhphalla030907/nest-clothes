import {
  createParamDecorator,
  type ExecutionContext,
  InternalServerErrorException,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../types/authenticated-request.js';

/**
 * Injects the authenticated user into a handler parameter.
 *
 * Replaces the `X-User-Id` header decorator this application used while it had no
 * authentication. Two properties matter, and both are the reason ownership is safe:
 *
 * - the value comes from `req.user`, which only `JwtAuthGuard` can set, and which it
 *   populates from a **database row** rather than from the token claims;
 * - nothing about the request can influence it, so there is no header, body field or
 *   path segment a caller could use to name a different user.
 *
 * No `ParseUUIDPipe` is needed here: the id has already been validated as a UUID by the
 * guard's database lookup, so a malformed identity is a 401 long before this runs.
 *
 * Throws rather than returning `undefined`, because a handler reaching for a user that
 * is not there means a route is missing its guard — a wiring bug that must fail loudly,
 * not a request state to be tolerated.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedRequest['user'] => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;

    if (user === undefined) {
      throw new InternalServerErrorException(
        'Authenticated user is unavailable on this route',
      );
    }

    return user;
  },
);
