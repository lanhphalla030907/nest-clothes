import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  DEFAULT_PROMOTION_PAGE_SIZE,
  DISCOUNT_TYPES,
  MAX_PROMOTION_PAGE_SIZE,
  PROMOTION_KINDS,
} from '../constants/promotion.constants.js';

/**
 * The filters the future administrative listing will accept.
 *
 * `archived` is a tri-state filter: `true` selects only archived rows, `false`
 * selects only live rows, and omitting it selects both. `isActive` is separate
 * because pausing and archiving are independent concepts.
 *
 * Query strings arrive as text, so the boolean filters canonicalise `'true'` and
 * `'false'` before `@IsBoolean` runs. Anything else is left untouched and
 * refused, matching the catalogue's filter DTO.
 */
export class PromotionListQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PROMOTION_PAGE_SIZE)
  limit: number = DEFAULT_PROMOTION_PAGE_SIZE;

  @IsOptional()
  @IsString()
  @IsIn(PROMOTION_KINDS)
  kind?: string;

  @IsOptional()
  @IsString()
  @IsIn(DISCOUNT_TYPES)
  discountType?: string;

  @Transform(({ value }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @Transform(({ value }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsOptional()
  @IsBoolean()
  archived?: boolean;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}
