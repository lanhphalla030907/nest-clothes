import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { normalizeName } from '../../common/utils/normalize-name.js';

/** Mirrors the `variant_options.option_name` column width. */
const OPTION_NAME_MAX_LENGTH = 50;

/** Mirrors the `variant_options.option_value` column width. */
const OPTION_VALUE_MAX_LENGTH = 100;

/**
 * Input contract for `POST /products/:productId/variants/:variantId/options`.
 *
 * `id`, `variantId`, `createdAt` and `updatedAt` are intentionally absent. The
 * global `ValidationPipe` runs with `forbidNonWhitelisted`, so a client
 * attempting to set any of them is rejected with 400 rather than having them
 * silently ignored — ownership and the timestamps are owned entirely by the
 * service and the database.
 *
 * Both fields are run through `normalizeName`, which trims and collapses every
 * internal run of whitespace into a single space, so `  Extra   Large  ` and
 * `Extra Large` are stored identically. A value that is only whitespace collapses
 * to the empty string and is rejected by `MinLength(1)`, which is what enforces
 * "required and non-empty".
 *
 * `optionName` is stored with its case preserved — `Color` stays `Color` — but
 * uniqueness is case-insensitive, so `Color` and `color` cannot both exist on one
 * variant. That rule is enforced by the service and by the database, not by
 * folding the case here.
 */
export class CreateVariantOptionDto {
  @Transform(({ value }) =>
    typeof value === 'string' ? normalizeName(value) : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(OPTION_NAME_MAX_LENGTH)
  optionName: string;

  @Transform(({ value }) =>
    typeof value === 'string' ? normalizeName(value) : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(OPTION_VALUE_MAX_LENGTH)
  optionValue: string;
}
