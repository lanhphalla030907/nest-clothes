import { Role } from '../../generated/prisma/enums.js';

/**
 * Roles allowed to use the delivery manager endpoints.
 *
 * ADMIN has full management authority. DELIVERY_MANAGER is the operational owner
 * of assignments. No other role may assign, reassign, list or inspect delivery
 * orders through the manager routes.
 */
export const DELIVERY_MANAGER_ROLES = [
  Role.ADMIN,
  Role.DELIVERY_MANAGER,
] as const;

/**
 * Roles allowed to use the delivery staff endpoints.
 *
 * Deliberately excludes ADMIN and DELIVERY_MANAGER: management authority must
 * not be used to impersonate delivery staff. Staff identity always comes from
 * the authenticated request, never from a client-supplied id.
 */
export const DELIVERY_STAFF_ROLES = [Role.DELIVERY_STAFF] as const;
