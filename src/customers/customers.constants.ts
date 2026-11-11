/**
 * Administrative customer-listing constants.
 *
 * These are business policy rather than schema details, so they live here
 * instead of being repeated in the DTOs, the service and the repository. The
 * list is deliberately read-only: this feature exists to observe customers,
 * never to change them.
 */

/** Default and maximum customer-listing page size. */
export const CUSTOMERS_DEFAULT_PAGE_SIZE = 20;
export const CUSTOMERS_MAX_PAGE_SIZE = 100;

/**
 * Columns the customer listing may be sorted by.
 *
 * `name` means the household's surname order — `(lastName, firstName)` —
 * because that is how an operator files a customer. `totalSpent` ranks by the
 * customer's **largest single-currency spend**: currencies are never combined,
 * so a customer who spent 100 USD and 100 KHR ranks by 100, not by a sum the
 * application has no exchange rate to compute.
 */
export const CUSTOMER_LIST_SORT_BY = [
  'createdAt',
  'name',
  'totalOrders',
  'totalSpent',
] as const;
export type CustomerListSortBy = (typeof CUSTOMER_LIST_SORT_BY)[number];

/** Sort directions. */
export const CUSTOMER_LIST_SORT_ORDERS = ['asc', 'desc'] as const;
export type CustomerListSortOrder =
  (typeof CUSTOMER_LIST_SORT_ORDERS)[number];

/** Default sort: newest registrations first. */
export const CUSTOMER_LIST_DEFAULT_SORT_BY: CustomerListSortBy = 'createdAt';
export const CUSTOMER_LIST_DEFAULT_SORT_ORDER: CustomerListSortOrder = 'desc';

/**
 * The "has this customer ever ordered?" filter.
 *
 * Both values count orders in **any** status, including `CANCELLED`: the
 * question is whether a relationship exists, not whether money moved.
 */
export const CUSTOMER_ORDER_ACTIVITY = [
  'WITH_ORDERS',
  'WITHOUT_ORDERS',
] as const;
export type CustomerOrderActivity = (typeof CUSTOMER_ORDER_ACTIVITY)[number];

/**
 * How many days back a registration counts as "new".
 *
 * The window is echoed in the stats response so a client never has to guess
 * which registrations the count covered.
 */
export const NEW_CUSTOMER_WINDOW_DAYS = 30;

/** How many of a customer's most recent orders the detail view returns. */
export const CUSTOMER_RECENT_ORDERS_LIMIT = 5;
