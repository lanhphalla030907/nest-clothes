import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
  NotEquals,
  ValidateNested,
} from 'class-validator';
import { normalizeMoney } from '../../common/utils/normalize-money.js';
import { normalizeSku } from '../../common/utils/normalize-sku.js';
import { ProductOptionDraftDto } from './product-option-draft.dto.js';

const SKU_PATTERN = /^[A-Z0-9]+(?:[._-][A-Z0-9]+)*$/;
const MONEY_PATTERN = /^\d{1,10}\.\d{2}$/;
const ZERO_AMOUNT = '0.00';
export const MAX_PRODUCT_VARIANTS = 500;

export class ProductVariantMatrixDraftDto {
  @IsOptional()
  @IsUUID()
  id?: string;

  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID(undefined, { each: true })
  optionValueIds: string[];

  @Transform(({ value }) =>
    typeof value === 'string' ? normalizeSku(value) : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Matches(SKU_PATTERN)
  sku: string;

  @Transform(({ value }) => normalizeMoney(value))
  @IsString()
  @Matches(MONEY_PATTERN)
  @NotEquals(ZERO_AMOUNT)
  price: string;

  @IsBoolean()
  isActive: boolean;
}

export class SaveProductOptionsDto {
  @IsInt()
  @Min(0)
  expectedRevision: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductOptionDraftDto)
  options: ProductOptionDraftDto[];

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PRODUCT_VARIANTS)
  @ValidateNested({ each: true })
  @Type(() => ProductVariantMatrixDraftDto)
  variants: ProductVariantMatrixDraftDto[];
}
