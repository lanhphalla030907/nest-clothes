import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { normalizeCategoryName } from '../../common/utils/normalize-category-name.js';
import { normalizeSlug } from '../../common/utils/normalize-slug.js';

/**
 * Accepted slug shape: lowercase alphanumeric words joined by single hyphens.
 *
 * The check runs *after* `normalizeSlug`, so a client may send `T-Shirts` and
 * it is stored as `t-shirts`.
 */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Mirrors the `categories` column widths so validation bounds the database. */
const NAME_MAX_LENGTH = 120;
const SLUG_MAX_LENGTH = 140;
const DESCRIPTION_MAX_LENGTH = 1000;

/**
 * Input contract for `PATCH /categories/:id`.
 *
 * Every field is optional, but the validation rules are deliberately repeated
 * rather than inherited: an update is validated exactly as strictly as a
 * create, and only the requiredness is relaxed.
 *
 * The difference between "field omitted" and "field set to `null"` is
 * meaningful and is honoured by the service:
 * - omitted  -> the stored column is left untouched
 * - `null`   -> `description` is cleared, `parentId` detaches the category and
 *               promotes it to a root category
 */
export class UpdateCategoryDto {
  @Transform(({ value }) =>
    typeof value === 'string' ? normalizeCategoryName(value) : value,
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

  /** `null` promotes the category to a root category. */
  @IsOptional()
  @IsUUID()
  parentId?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}