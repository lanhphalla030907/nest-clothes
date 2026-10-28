import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { PRODUCT_STATUS, type ProductStatus } from '../constants/product-status.constants.js';

/**
 * The four narrowing questions a catalogue manager asks of a listing, and nothing else.
 *
 * Every field is optional and they combine with `AND`. Each is validated here rather
 * than being passed through to Prisma unchecked: a filter is still client input, so an
 * unvalidated `isActive=maybe` or a `categoryId` that is not a UUID has to be a 400 and
 * not a database error.
 *
 * `search` is trimmed and length-bounded for the same reason: it is the one field that
 * reaches a `LIKE` pattern, and an unbounded one is a needless way to ask the index for
 * a full scan of the table.
 */
export class ProductFilterQueryDto {
  /**
   * Constrained to the three real statuses rather than left as free text: a filter that
   * can only ever match nothing is a typo the caller should be told about, and the
   * lifecycle DTOs already hold the caller to the same list on a write.
   */
  @IsOptional()
  @IsString()
  @IsIn(Object.values(PRODUCT_STATUS))
  status?: ProductStatus;

  /**
   * A query string arrives as text, so `'false'` and `'true'` are what arrives too.
   * `Transform` canonicalises them before `@IsBoolean` runs; anything that is neither
   * is left as the original string and refused.
   */
  @Transform(({ value }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}