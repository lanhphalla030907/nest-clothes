import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  DISCOUNT_TYPES,
  PROMOTION_KINDS,
} from '../constants/promotion.constants.js';
import { normalizePromotionCode } from '../utils/promotion-code.js';

const MONEY_PATTERN = /^\d{1,10}(?:\.\d{1,2})?$/;
const PERCENT_PATTERN = /^\d{1,3}(?:\.\d{1,2})?$/;

/**
 * A partial promotion update.
 *
 * `null` is meaningful for the nullable fields: it clears the value. An omitted
 * property means "leave it as it is". The service merges the update over the
 * existing row and then validates the *resulting* promotion, so a change of
 * `discountType` cannot leave the row in a shape the database would reject.
 *
 * As with the create DTO, these decorators are the future HTTP contract; the
 * service repeats the rules for any caller that bypasses the pipe.
 */
export class UpdatePromotionDto {
  @Transform(({ value }) =>
    typeof value === 'string' ? normalizePromotionCode(value) : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(50)
  code?: string | null;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @IsOptional()
  @IsString()
  @IsIn(PROMOTION_KINDS)
  kind?: string;

  @IsOptional()
  @IsString()
  @IsIn(DISCOUNT_TYPES)
  discountType?: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @Matches(PERCENT_PATTERN, {
    message: 'percentOff must be a decimal with at most 2 fraction digits',
  })
  percentOff?: string | null;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @Matches(MONEY_PATTERN, {
    message:
      'amountOff must be a non-negative amount with at most 2 fraction digits',
  })
  amountOff?: string | null;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @Matches(MONEY_PATTERN, {
    message:
      'minSubtotal must be a non-negative amount with at most 2 fraction digits',
  })
  minSubtotal?: string | null;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @Matches(MONEY_PATTERN, {
    message:
      'maxDiscount must be a non-negative amount with at most 2 fraction digits',
  })
  maxDiscount?: string | null;

  @IsOptional()
  @IsString()
  @IsISO8601({ strict: true, strictSeparator: true })
  startsAt?: string | null;

  @IsOptional()
  @IsString()
  @IsISO8601({ strict: true, strictSeparator: true })
  endsAt?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  usageLimitTotal?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  usageLimitPerUser?: number | null;

  @IsOptional()
  @IsInt()
  priority?: number;
}
