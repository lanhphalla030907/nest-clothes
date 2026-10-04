import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import {
  ADDRESS_LINE_MAX_LENGTH,
  CITY_MAX_LENGTH,
  COUNTRY_CODE_PATTERN,
  LABEL_MAX_LENGTH,
  PHONE_MAX_LENGTH,
  POSTAL_CODE_MAX_LENGTH,
  RECIPIENT_NAME_MAX_LENGTH,
  STATE_PROVINCE_MAX_LENGTH,
  normalizeCountryCode,
  trimOptionalField,
  trimRequiredField,
} from './address-field.rules.js';

/**
 * Accepted country shape, identical to `CreateAddressDto`: exactly two uppercase
 * letters after normalisation.
 */

/**
 * Input contract for `PATCH /addresses/:id`.
 *
 * Every field is optional, but the validation rules are deliberately repeated
 * rather than inherited: an update is validated exactly as strictly as a create and
 * only the requiredness is relaxed. A `PATCH` must not be able to write a value
 * `POST` would have refused.
 *
 * The difference between "field omitted" and "field set to `null`" is meaningful
 * and is honoured by the service:
 *
 * - omitted  -> the stored column is left untouched
 * - `null`   -> `addressLine2`, `stateProvince` and `postalCode` are cleared
 *
 * `null` is accepted **only** for the three nullable columns. Clearing a required
 * one is a 400, because an address with no street or no city is not a partial
 * address, it is a broken one. (Those same columns also accept `""`, which the
 * shared trim rule collapses to `null` — see `address-field.rules.ts`.)
 *
 * This is why the required fields use `@ValidateIf(value !== undefined)` rather
 * than `@IsOptional()`: `@IsOptional()` also skips validation for `null`, which
 * would let `{"city": null}` through and null out a column the schema declares
 * `NOT NULL`. `@ValidateIf` skips only the genuinely absent case.
 *
 * ## `isDefault` is not an ordinary field here
 *
 * It is a request to *move* the user's single default, not a column to write, and
 * the service treats it as such:
 *
 * - `true`  -> demote the incumbent and promote this address, in one transaction
 * - `false` -> rejected with 409 when the address is currently the default, and a
 *   no-op otherwise
 *
 * Accepting `isDefault: false` on the current default would leave the user with no
 * default at all, which is the one state the invariant exists to prevent: a
 * checkout could no longer pre-fill itself without asking.
 */
export class UpdateAddressDto {
  @Transform(trimRequiredField)
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(LABEL_MAX_LENGTH)
  label?: string;

  @Transform(trimRequiredField)
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(RECIPIENT_NAME_MAX_LENGTH)
  recipientName?: string;

  @Transform(trimRequiredField)
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(PHONE_MAX_LENGTH)
  phone?: string;

  @Transform(trimRequiredField)
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(ADDRESS_LINE_MAX_LENGTH)
  addressLine1?: string;

  @Transform(trimOptionalField)
  @IsOptional()
  @IsString()
  @MaxLength(ADDRESS_LINE_MAX_LENGTH)
  addressLine2?: string | null;

  @Transform(trimRequiredField)
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(CITY_MAX_LENGTH)
  city?: string;

  @Transform(trimOptionalField)
  @IsOptional()
  @IsString()
  @MaxLength(STATE_PROVINCE_MAX_LENGTH)
  stateProvince?: string | null;

  @Transform(trimOptionalField)
  @IsOptional()
  @IsString()
  @MaxLength(POSTAL_CODE_MAX_LENGTH)
  postalCode?: string | null;

  @Transform(normalizeCountryCode)
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @Matches(COUNTRY_CODE_PATTERN, {
    message: 'countryCode must be exactly two uppercase letters',
  })
  countryCode?: string;

  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean()
  isDefault?: boolean;
}
