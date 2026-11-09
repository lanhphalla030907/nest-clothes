/**
 * Client-facing validation messages shared by the service and its tests.
 *
 * Keeping the literals in one module means a test asserts the same sentence the
 * caller will see, rather than duplicating it and drifting from the service.
 */
export const PROMOTION_MESSAGES = {
  KIND_INVALID: 'kind must be COUPON or AUTOMATIC',
  DISCOUNT_TYPE_INVALID:
    'discountType must be PERCENTAGE, FIXED_AMOUNT or FREE_SHIPPING',
  CODE_REQUIRED: 'A COUPON promotion requires a code',
  CODE_NOT_ALLOWED: 'An AUTOMATIC promotion cannot have a code',
  CODE_TOO_LONG: 'code must be at most 50 characters',
  NAME_REQUIRED: 'name is required',
  NAME_TOO_LONG: 'name must be at most 120 characters',
  DESCRIPTION_TOO_LONG: 'description must be at most 500 characters',
  PERCENTAGE_REQUIRED:
    'A PERCENTAGE promotion requires percentOff greater than 0 and at most 100',
  PERCENTAGE_RANGE: 'percentOff must be greater than 0 and at most 100',
  PERCENTAGE_NOT_ALLOWED:
    'percentOff is only allowed for a PERCENTAGE promotion',
  FIXED_AMOUNT_REQUIRED:
    'A FIXED_AMOUNT promotion requires amountOff greater than 0',
  FIXED_AMOUNT_POSITIVE: 'amountOff must be greater than 0',
  FIXED_AMOUNT_NOT_ALLOWED:
    'amountOff is only allowed for a FIXED_AMOUNT promotion',
  FREE_SHIPPING_FIELDS_ABSENT:
    'A FREE_SHIPPING promotion cannot have percentOff or amountOff',
  MIN_SUBTOTAL_NON_NEGATIVE: 'minSubtotal must be a non-negative amount',
  MAX_DISCOUNT_POSITIVE: 'maxDiscount must be greater than 0 when provided',
  USAGE_LIMIT_TOTAL_NON_NEGATIVE:
    'usageLimitTotal must be a non-negative integer',
  USAGE_LIMIT_PER_USER_NON_NEGATIVE:
    'usageLimitPerUser must be a non-negative integer',
  PRIORITY_INTEGER: 'priority must be an integer',
  DATE_INVALID: 'must be a valid ISO-8601 timestamp',
  DATE_RANGE_INVALID:
    'endsAt must be later than startsAt when both are present',
  CODE_DUPLICATE: 'A promotion with this code already exists',
  COUPON_NOT_APPLICABLE:
    'The coupon code is invalid or is no longer eligible. It may be expired, paused, archived, over its usage limit, or below its minimum spend.',
  COUPON_NO_LONGER_VALID:
    'The coupon on this quote is no longer valid. Request a new quote.',
  NOT_FOUND: (id: string) => `Promotion ${id} does not exist`,
  ARCHIVED_CANNOT_ACTIVATE: 'An archived promotion cannot be activated',
  PAGE_INVALID: 'page must be a positive integer',
  LIMIT_INVALID: 'limit must be a positive integer no greater than 100',
  SEARCH_TOO_LONG: 'search must be at most 200 characters',
} as const;
