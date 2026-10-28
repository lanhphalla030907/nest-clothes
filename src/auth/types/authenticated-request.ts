import type { AuthenticatedUser } from './authenticated-user.js';

/**
 * The subset of an Express request this application's authentication reads.
 *
 * Declared here rather than by augmenting Express's global `Request`, so that adding
 * authentication is one type in one file and nothing outside it is affected. A
 * controller reads `request.user` through the `CurrentUser` decorator, never by casting.
 *
 * `user` is absent until `JwtAuthGuard` has run, which is why every route that reads it
 * mounts that guard. `AuthenticatedUser` holds no `passwordHash` and no `status`.
 */
export interface AuthenticatedRequest {
  user?: AuthenticatedUser;

  /**
   * The incoming headers, as the guard reads them.
   *
   * Values are `unknown` because an untrusted request can put anything here: a header
   * arrives as a string, a repeated header as an array, and an absent one is not present
   * at all. `JwtAuthGuard` narrows before using any of it, so nothing downstream has to
   * treat a header as trustworthy.
   */
  headers?: Record<string, unknown>;
}
