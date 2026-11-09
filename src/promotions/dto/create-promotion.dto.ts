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
 * The domain input for creating a promotion.
 *
 * There is deliberately no controller in this phase, so these decorators are the
 * contract a future HTTP layer will inherit. They are not the only validation:
 * `PromotionsService` re-checks every rule, because a service call can arrive
 * without passing through Nest's `ValidationPipe`.
 *
 * Money and percentage values are strings, matching every other monetary DTO in
 * the project. A JSON number would be a float on the way in and could not carry
 * a two-decimal amount exactly.
 */
export class CreatePromotionDto {
  @Transform(({ value }) =>
    typeof value === 'string' ? normalizePromotionCode(value) : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(50)
  code?: string | null;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @IsString()
  @IsIn(PROMOTION_KINDS)
  kind: string;

  @IsString()
  @IsIn(DISCOUNT_TYPES)
  discountType: string;

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
