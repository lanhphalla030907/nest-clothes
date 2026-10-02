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
 * Input contract for `POST /products`.
 *
 * `id`, `status`, `isActive`, `createdAt` and `updatedAt` are intentionally
 * absent. The global `ValidationPipe` runs with `forbidNonWhitelisted`, so a
 * client attempting to set any of them is rejected with 400 rather than having
 * them silently ignored — the lifecycle is owned entirely by the service.
 *
 * `basePrice` is typed as `string` because `normalizeMoney` canonicalises the
 * incoming number *or* string into a two-decimal string before validation runs.
 * The service persists that exact string, so the amount never passes through a
 * float on its way to the column.
 */
export class CreateProductDto {
  @Transform(({ value }) =>
    typeof value === 'string' ? normalizeName(value) : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(NAME_MAX_LENGTH)
  name: string;

  @Transform(({ value }) =>
    typeof value === 'string' ? normalizeSlug(value) : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(SLUG_MAX_LENGTH)
  @Matches(SLUG_PATTERN, {
    message:
      'slug must be lowercase alphanumeric words separated by single hyphens',
  })
  slug: string;

  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(DESCRIPTION_MAX_LENGTH)
  description?: string;

  @Transform(({ value }) => normalizeMoney(value))
  @IsString()
  @Matches(MONEY_PATTERN, {
    message:
      'basePrice must be a positive amount with at most 2 decimal places and at most 10 integer digits',
  })
  @NotEquals(ZERO_AMOUNT, { message: 'basePrice must be greater than 0' })
  basePrice: string;

  @IsUUID()
  categoryId: string;
}