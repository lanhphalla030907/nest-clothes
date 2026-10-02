import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  NotEquals,
} from 'class-validator';
import { normalizeMoney } from '../../common/utils/normalize-money.js';
import { normalizeName } from '../../common/utils/normalize-name.js';
import { normalizeSlug } from '../../common/utils/normalize-slug.js';

/**
 * Accepted slug shape: lowercase alphanumeric words joined by single hyphens.
 *
 * The check runs *after* `normalizeSlug`, so a client may send
 * `OVERSIZED-T-SHIRT` and it is stored as `oversized-t-shirt`.
 */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Accepted monetary shape after `normalizeMoney`: at most ten integer digits
 * (the width of `Decimal(12,2)`) followed by exactly two fraction digits.
 */
const MONEY_PATTERN = /^\d{1,10}\.\d{2}$/;

/** The canonical zero the amount must differ from, so the price is positive. */
const ZERO_AMOUNT = '0.00';

/** Mirrors the `products` column widths so validation bounds the database. */
const NAME_MAX_LENGTH = 200;
const SLUG_MAX_LENGTH = 220;
const DESCRIPTION_MAX_LENGTH = 5000;

/**
 * Input contract for `PATCH /products/:id`.
 *
 * Only editable catalog content is accepted. `id`, `status`, `isActive`,
 * `createdAt` and `updatedAt` are absent, and because the global pipe runs
 * `forbidNonWhitelisted` a client that sends them gets a 400 instead of a
 * silently ignored field. Moving a product through its lifecycle is a separate,
 * authorised action that does not exist yet.
 *
 * Every field is optional, but the validation rules are deliberately repeated
 * rather than inherited: an update is validated exactly as strictly as a create,
 * and only the requiredness is relaxed.
 *
 * The difference between "field omitted" and "field set to `null"` is
 * meaningful and is honoured by the service:
 * - omitted  -> the stored column is left untouched
 * - `null`   -> `description` is cleared
 *
 * `categoryId` is not nullable: every product belongs to exactly one category,
 * so a product is re-parented rather than orphaned.
 */
export class UpdateProductDto {
  @Transform(({ value }) =>
    typeof value === 'string' ? normalizeName(value) : value,
  )
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(NAME_MAX_LENGTH)
  name?: string;

  @Transform(({ value }) =>
    typeof value === 'string' ? normalizeSlug(value) : value,
  )
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(SLUG_MAX_LENGTH)
  @Matches(SLUG_PATTERN, {
    message:
      'slug must be lowercase alphanumeric words separated by single hyphens',
  })
  slug?: string;

  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(DESCRIPTION_MAX_LENGTH)
  description?: string | null;

  @Transform(({ value }) => normalizeMoney(value))
  @IsOptional()
  @IsString()
  @Matches(MONEY_PATTERN, {
    message:
      'basePrice must be a positive amount with at most 2 decimal places and at most 10 integer digits',
  })
  @NotEquals(ZERO_AMOUNT, { message: 'basePrice must be greater than 0' })
  basePrice?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;
}