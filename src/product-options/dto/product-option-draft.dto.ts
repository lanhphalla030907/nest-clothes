import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class ProductOptionValueDraftDto {
  @IsOptional()
  @IsUUID()
  id?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  value: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;
}

export class ProductOptionDraftDto {
  @IsOptional()
  @IsUUID()
  id?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(50)
  name: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ProductOptionValueDraftDto)
  values: ProductOptionValueDraftDto[];
}

export class PreviewProductOptionsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductOptionDraftDto)
  options: ProductOptionDraftDto[];
}
