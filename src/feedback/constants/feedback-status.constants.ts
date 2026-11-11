/**
 * Publication status of a feedback row.
 *
 * Deliberately a string constant set rather than a database enum, matching the
 * `Order.status` / `Product.status` convention: adding a status later is a code
 * change, not an `ALTER TYPE`. The service is the authority on which values exist.
 */

export const FEEDBACK_STATUS_PUBLISHED = 'PUBLISHED';
export const FEEDBACK_STATUS_UNPUBLISHED = 'UNPUBLISHED';

export const FEEDBACK_STATUSES = [
  FEEDBACK_STATUS_PUBLISHED,
  FEEDBACK_STATUS_UNPUBLISHED,
] as const;

export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/** Page sizes the feedback listings accept. */
export const FEEDBACK_PAGE_SIZES = [10, 20, 50, 100] as const;
export const DEFAULT_FEEDBACK_PAGE_SIZE = 20;

/** Column widths mirrored by the DTO validation. */
export const TITLE_MAX_LENGTH = 200;
export const MESSAGE_MAX_LENGTH = 5000;
