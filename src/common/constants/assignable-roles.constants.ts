import { Role } from '../../generated/prisma/enums.js';

/**
 * The role values an administrator may assign from the user-management screen.
 *
 * `DELIVERY_MANAGER` is deliberately absent: that role is granted by the delivery
 * workflow, never by this generic role picker. Keeping the allow-list on the server
 * means a crafted request cannot bypass the options shown in the UI.
 */
export const ASSIGNABLE_ROLES: readonly Role[] = [
  Role.CUSTOMER,
  Role.ADMIN,
  Role.DELIVERY_STAFF,
];
