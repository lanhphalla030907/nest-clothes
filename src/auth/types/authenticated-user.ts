import type { Role } from '../../generated/prisma/enums.js';

/**
 * The identity a verified access token resolves to.
 *
 * Everything here comes from the database row the guard loaded, **not** from the token
 * claims — see `JwtAuthGuard`. A token can therefore never assert a role or an id the
 * user table does not agree with, and suspending or deleting an account takes effect on
 * its next request rather than whenever its token expires.
 *
 * It carries no `passwordHash` and no `status`, so it is safe to attach to a request
 * and to read in a controller.
 */
export interface AuthenticatedUser {
  readonly id: string;
  readonly email: string;
  readonly role: Role;
}
