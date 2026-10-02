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

/**
 * Max lengths mirror the `categories` column widths so a payload can never
 * pass validation and then be rejected by PostgreSQL.
 */
const NAME_MAX_LENGTH = 120;
const SLUG_MAX_LENGTH = 140;
const DESCRIPTION_MAX_LENGTH = 1000;

/**
 * Input contract for `POST /categories`.
 *
 * `id`, `createdAt` and `updatedAt` are intentionally absent: the global
 * `ValidationPipe` runs with `forbidNonWhitelisted`, so a client attempting to
 * set them is rejected with 400 instead of silently having them ignored.
 */
export class CreateCategoryDto {
  @Transform(({ value }) =>
    typeof value === 'string' ? normalizeCategoryName(value) : value,
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

  /** Absent or `null` creates a root category. */
  @IsOptional()
  @IsUUID()
  parentId?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}