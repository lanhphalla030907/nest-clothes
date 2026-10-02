import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { normalizeName } from '../../common/utils/normalize-name.js';

/** Mirrors the `variant_options.option_name` column width. */
const OPTION_NAME_MAX_LENGTH = 50;

/** Mirrors the `variant_options.option_value` column width. */
const OPTION_VALUE_MAX_LENGTH = 100;

/**
 * Input contract for
 * `PATCH /products/:productId/variants/:variantId/options/:optionId`.
 *
 * Only editable option attributes are accepted. `id`, `variantId`, `createdAt`
 * and `updatedAt` are absent, and because the global pipe runs
 * `forbidNonWhitelisted` a client that sends them gets a 400 instead of a
 * silently ignored field. Moving an option to another variant is not an edit; it
 * is a separate, authorised action that does not exist yet.
 *
 * Every field is optional, but the validation rules are deliberately repeated
 * rather than inherited: an update is validated exactly as strictly as a create,
 * and only the requiredness is relaxed. Both fields still go through
 * `normalizeName`, so a patch normalises the same way a create does.
 */
export class UpdateVariantOptionDto {
  @Transform(({ value }) =>
    typeof value === 'string' ? normalizeName(value) : value,
  )
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(OPTION_NAME_MAX_LENGTH)
  optionName?: string;

  @Transform(({ value }) =>
    typeof value === 'string' ? normalizeName(value) : value,
  )
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(OPTION_VALUE_MAX_LENGTH)
  optionValue?: string;
}
