import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { normalizeMoney } from '../../common/utils/normalize-money.js';
import { normalizeShippingProviderCode } from '../../common/utils/normalize-shipping-provider-code.js';

const CODE_PATTERN = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const MONEY_PATTERN = /^\d{1,10}\.\d{2}$/;
const CODE_MAX_LENGTH = 50;
const NAME_MAX_LENGTH = 120;
const DESCRIPTION_MAX_LENGTH = 500;

export class CreateShippingProviderDto {
  @Transform(({ value }) =>
    typeof value === 'string' ? normalizeShippingProviderCode(value) : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(CODE_MAX_LENGTH)
  @Matches(CODE_PATTERN, {
    message:
      'code must contain uppercase letters or numbers separated by single hyphens',
  })
  code: string;

  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(NAME_MAX_LENGTH)
  name: string;

  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(DESCRIPTION_MAX_LENGTH)
  description?: string | null;

  @Transform(({ value }) => normalizeMoney(value))
  @IsString()
  @Matches(MONEY_PATTERN, {
    message:
      'baseFee must be a non-negative amount with at most 2 decimal places and at most 10 integer digits',
  })
  baseFee: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  supportsCod?: boolean;
}
