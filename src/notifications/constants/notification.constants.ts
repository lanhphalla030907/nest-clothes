/**
 * Pagination defaults for the notification center.
 *
 * Kept small: the dropdown only asks for the latest handful, while the center
 * page reads at most one page of this size. A larger ceiling would let a caller
 * turn one request into an unbounded scan of a user's history.
 */
export const DEFAULT_NOTIFICATION_PAGE_SIZE = 20;
export const MAX_NOTIFICATION_PAGE_SIZE = 100;

/** How many latest notifications the header dropdown requests. */
export const NOTIFICATION_DROPDOWN_LIMIT = 8;

export const NOTIFICATION_NOT_FOUND = 'Notification does not exist';
