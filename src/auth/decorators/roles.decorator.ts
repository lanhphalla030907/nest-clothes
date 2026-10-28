import { SetMetadata } from '@nestjs/common';
import { Role } from '../../generated/prisma/enums.js';

/** Metadata key `RolesGuard` reads. */
export const ROLES_KEY = 'roles';

/**
 * Declares which roles may reach a route.
 *
 * Read by `RolesGuard`, which always runs after `JwtAuthGuard`, so the role it compares
 * against comes from the database row and not from anything the client sent.
 *
 * ```ts
 * @Roles(Role.ADMIN)
 * @UseGuards(JwtAuthGuard, RolesGuard)
 * ```
 *
 * A route with no `@Roles` is open to any authenticated user, which is the usual case;
 * this decorator only narrows further.
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
