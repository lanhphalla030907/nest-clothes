import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator.js';
import type { AuthenticatedRequest } from '../types/authenticated-request.js';
import { UNAUTHENTICATED_MESSAGE } from './jwt-auth.guard.js';

/**
 * Message for an authenticated caller that lacks the required role.
 *
 * Names no role and no requirement, so a 403 does not tell a caller which role it would
 * have needed.
 */
export const FORBIDDEN_MESSAGE = 'Forbidden resource';

/**
 * Enforces `@Roles(...)` on a route.
 *
 * The distinction the two status codes draw is the whole point of this guard:
 *
 * - **401** — no verified identity. There is nobody to authorise, so the answer is the
 *   same one `JwtAuthGuard` gives, whether the token was missing, malformed or expired.
 * - **403** — a verified identity that is not permitted. The caller is known and the
 *   request is refused; retrying with the same token cannot help.
 *
 * A route with no `@Roles` is open to any authenticated user, so a guard mounted
 * without the decorator is a no-op rather than a 403 — which is what makes it safe to
 * add `@UseGuards(JwtAuthGuard, RolesGuard)` at a controller level and mark up only the
 * routes that need narrowing.
 *
 * Must run after `JwtAuthGuard`: it reads the identity that guard attaches to the
 * request, and it deliberately does not authenticate anything itself.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<unknown>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!Array.isArray(required) || required.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;

    // Reached when the guard is mounted without `JwtAuthGuard`: without a verified
    // identity there is nothing to authorise, which is 401 rather than 403.
    if (user === undefined) {
      throw new UnauthorizedException(UNAUTHENTICATED_MESSAGE);
    }

    if (!required.includes(user.role)) {
      throw new ForbiddenException(FORBIDDEN_MESSAGE);
    }

    return true;
  }
}
