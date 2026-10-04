import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { normalizeName } from '../../common/utils/normalize-name.js';

/** Mirrors the `product_attributes.attribute_name` column width. */
const ATTRIBUTE_NAME_MAX_LENGTH = 50;

/** Mirrors the `product_attributes.attribute_value` column width. */
const ATTRIBUTE_VALUE_MAX_LENGTH = 255;

/**
 * Input contract for `PATCH /products/:productId/attributes/:attributeId`.
 *
 * Only editable attribute content is accepted. `id`, `productId`, `createdAt` and
 * `updatedAt` are absent, and because the global pipe runs
 * `forbidNonWhitelisted` a client that sends them gets a 400 instead of a
 * silently ignored field. Moving an attribute to another product is not an edit;
 * it is a separate, authorised action that does not exist yet.
 *
 * Every field is optional, but the validation rules are deliberately repeated
 * rather than inherited: an update is validated exactly as strictly as a create,
 * and only the requiredness is relaxed. Both fields still go through
 * `normalizeName`, so a patch normalises the same way a create does.
 */
export class UpdateProductAttributeDto {
  @Transform(({ value }) =>
    typeof value === 'string' ? normalizeName(value) : value,
  )
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(ATTRIBUTE_NAME_MAX_LENGTH)
  attributeName?: string;

  @Transform(({ value }) =>
    typeof value === 'string' ? normalizeName(value) : value,
  )
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(ATTRIBUTE_VALUE_MAX_LENGTH)
  attributeValue?: string;
}
