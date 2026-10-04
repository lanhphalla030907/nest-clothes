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
  LABEL_MAX_LENGTH,
  PHONE_MAX_LENGTH,
  POSTAL_CODE_MAX_LENGTH,
  normalizeCountryCode,
  RECIPIENT_NAME_MAX_LENGTH,
  STATE_PROVINCE_MAX_LENGTH,
  trimOptionalField,
  trimRequiredField,
} from './address-field.rules.js';

/**
 * Accepted country shape: exactly two uppercase letters.
 *
 * The check runs *after* `normalizeCountryCode`, so `"us"` and `" us "` are both
 * accepted and stored as `"US"`. This is the ISO 3166-1 alpha-2 shape and nothing
 * more — no membership check against a list of real countries. A closed list would
 * reject addresses in places our data has not caught up with, and there is no
 * country reference table in this schema by design.
 */
const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;

/**
 * Input contract for `POST /addresses`.
 *
 * `id`, `userId`, `createdAt` and `updatedAt` are intentionally absent. The global
 * `ValidationPipe` runs with `forbidNonWhitelisted`, so a client attempting to set
 * any of them gets a 400 rather than having them silently dropped — the owner
 * comes from the request identity, and the timestamps belong to the database.
 *
 * `isDefault` is optional and defaults to `false`. The service raises it on its own
 * for a user's first address, so a client never has to know that rule in order to
 * end up with a usable address book.
 *
 * `phone` and `postalCode` are bounded but otherwise unconstrained. Validating
 * their *shape* would mean assuming a country: `+44` numbers vary in length and
 * grouping, North American and Japanese postal codes share digits and hyphens in
 * different arrangements, and plenty of countries have no postal codes at all. A
 * regex written for one market silently corrupts addresses in the others, so the
 * only rules are "present" and "no longer than the column".
 *
 * `stateProvince`, `addressLine2` and `postalCode` are optional because whether a
 * country uses states, and whether a customer has an apartment line, are local
 * conventions rather than universal fields.
 */
export class CreateAddressDto {
  /** A short name for the customer to recognise it by, such as `Home`. */
  @Transform(trimRequiredField)
  @IsString()
  @MinLength(1)
  @MaxLength(LABEL_MAX_LENGTH)
  label: string;

  /** Who the parcel is for. Not assumed to be the account holder. */
  @Transform(trimRequiredField)
  @IsString()
  @MinLength(1)
  @MaxLength(RECIPIENT_NAME_MAX_LENGTH)
  recipientName: string;

  /**
   * Kept as a string, never a number: a leading `+`, a leading zero and spaces are
   * all significant in the international formats this has to survive.
   */
  @Transform(trimRequiredField)
  @IsString()
  @MinLength(1)
  @MaxLength(PHONE_MAX_LENGTH)
  phone: string;

  @Transform(trimRequiredField)
  @IsString()
  @MinLength(1)
  @MaxLength(ADDRESS_LINE_MAX_LENGTH)
  addressLine1: string;

  @Transform(trimOptionalField)
  @IsOptional()
  @IsString()
  @MaxLength(ADDRESS_LINE_MAX_LENGTH)
  addressLine2?: string | null;

  @Transform(trimRequiredField)
  @IsString()
  @MinLength(1)
  @MaxLength(CITY_MAX_LENGTH)
  city: string;

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
  @IsString()
  @Matches(COUNTRY_CODE_PATTERN, {
    message: 'countryCode must be exactly two letters',
  })
  countryCode: string;

  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean()
  isDefault?: boolean;
}
