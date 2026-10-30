import { DeliveryStatus } from '../../generated/prisma/enums.js';

/**
 * Valid delivery status transitions for assignments.
 * Order.status is never changed by delivery logic.
 */
export const DELIVERY_STATUS_TRANSITIONS: Record<DeliveryStatus, DeliveryStatus[]> = {
  PENDING_ASSIGNMENT: ['ASSIGNED'],
  ASSIGNED: ['OUT_FOR_DELIVERY', 'FAILED_DELIVERY', 'RETURNED'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'FAILED_DELIVERY', 'RETURNED'],
  DELIVERED: [],
  FAILED_DELIVERY: ['OUT_FOR_DELIVERY', 'RETURNED'],
  RETURNED: [],
};

export function isValidDeliveryTransition(
  from: DeliveryStatus,
  to: DeliveryStatus,
): boolean {
  if (from === to) {
    return false;
  }
  return (DELIVERY_STATUS_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * Order statuses that are eligible for delivery assignment.
 * Only orders that have been confirmed/paid and are ready for delivery can be assigned.
 * Cancelled orders must not be assigned.
 */
export const ELIGIBLE_ORDER_STATUSES_FOR_ASSIGNMENT = ['CONFIRMED', 'PROCESSING'];
