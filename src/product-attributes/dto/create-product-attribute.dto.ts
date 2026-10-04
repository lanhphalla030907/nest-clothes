import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { normalizeName } from '../../common/utils/normalize-name.js';

/** Mirrors the `product_attributes.attribute_name` column width. */
const ATTRIBUTE_NAME_MAX_LENGTH = 50;

/** Mirrors the `product_attributes.attribute_value` column width. */
const ATTRIBUTE_VALUE_MAX_LENGTH = 255;

/**
 * Input contract for `POST /products/:productId/attributes`.
 *
 * `id`, `productId`, `createdAt` and `updatedAt` are intentionally absent. The
 * global `ValidationPipe` runs with `forbidNonWhitelisted`, so a client
 * attempting to set any of them is rejected with 400 rather than having them
 * silently ignored — ownership and the timestamps are owned entirely by the
 * service and the database.
 *
 * Both fields are run through `normalizeName`, which trims and collapses every
 * internal run of whitespace into a single space, so `  Machine   Wash  ` and
 * `Machine Wash` are stored identically. A value that is only whitespace
 * collapses to the empty string and is rejected by `MinLength(1)`, which is what
 * enforces "required and non-empty".
 *
 * `attributeName` is stored with its case preserved — `Material` stays
 * `Material` — but uniqueness is case-insensitive, so `Material` and `material`
 * cannot both exist on one product. That rule is enforced by the service and by
 * the database, not by folding the case here.
 */
export class CreateProductAttributeDto {
  @Transform(({ value }) =>
    typeof value === 'string' ? normalizeName(value) : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(ATTRIBUTE_NAME_MAX_LENGTH)
  attributeName: string;

  @Transform(({ value }) =>
    typeof value === 'string' ? normalizeName(value) : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(ATTRIBUTE_VALUE_MAX_LENGTH)
  attributeValue: string;
}
