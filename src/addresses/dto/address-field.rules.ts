/**
 * Accepted country shape: exactly two uppercase letters. Shared by the create and
 * update DTOs so the two endpoints can never drift apart.
 */
export const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;

/**
 * Shared input rules for the fields an address is made of.
 *
 * They live here because a create and an update must agree exactly on what a
 * valid value is. Only the *requiredness* differs between the two contracts:
 * relaxing the rules on `PATCH` would mean an address could be edited into a state
 * that `POST` would have refused.
 *
 * ## Trimming happens before validation, not after
 *
 * Every transform runs ahead of the validators, so `"  Home  "` is measured as
 * `Home` and stored as `Home`. This matters more than it looks: without it a
 * label of `"   "` would satisfy `MaxLength(50)` and be stored as three spaces,
 * which renders as an invisible row in an address picker, and a `recipientName` of
 * `" Ada  "` would be compared and de-duplicated differently from `"Ada"`.
 */

/**
 * Trims a string, and collapses an all-whitespace string to `null`.
 *
 * The `null` half is what lets an optional field be *cleared* with
 * `{ "addressLine2": "" }` as well as with `{ "addressLine2": null }`. Both spell
 * "there is no second line"; treating them identically avoids storing `''` — which
 * is not `NULL` in the database, so `address_line2 IS NULL` queries and the
 * "optional field is empty" checks would both miss it.
 *
 * A non-string value is passed through untouched so the validator, not this
 * helper, reports the type error with a useful message.
 */
export const trimRequiredField = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** Trim, then treat a blank optional string as absent. See {@link trimRequiredField}. */
export const trimOptionalField = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' && value.trim() === ''
    ? null
    : trimRequiredField({ value });

/**
 * Uppercases and trims a country code.
 *
 * ISO 3166-1 alpha-2 codes are canonically uppercase, and a client that sends
 * `"us"` or `" us "` means the United States. Normalising on the way in means the
 * stored column has exactly one spelling of each country, so grouping or filtering
 * by country later cannot be defeated by casing.
 *
 * Anything that is not two letters afterwards is rejected by the `@Matches` on the
 * field itself; this helper deliberately does not validate so the error message
 * comes from the declared rule.
 */
export const normalizeCountryCode = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

/**
 * Maximum lengths, mirroring the `addresses` column widths so validation rejects
 * what the database would truncate or reject anyway, with a 400 that names the
 * field instead of a driver error.
 */
export const LABEL_MAX_LENGTH = 50;
export const RECIPIENT_NAME_MAX_LENGTH = 150;
export const PHONE_MAX_LENGTH = 30;
export const ADDRESS_LINE_MAX_LENGTH = 255;
export const CITY_MAX_LENGTH = 100;
export const STATE_PROVINCE_MAX_LENGTH = 100;
export const POSTAL_CODE_MAX_LENGTH = 20;
