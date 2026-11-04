import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export enum BulkInventoryOperation {
  SET = 'SET',
  INCREASE = 'INCREASE',
  DECREASE = 'DECREASE',
}

export class ExpectedInventoryDto {
  @IsUUID('4')
  variantId: string;

  @IsOptional()
  @IsBoolean()
  inventoryExists?: boolean;

  @IsInt()
  @Min(0)
  quantity: number;

  @IsInt()
  @Min(0)
  reservedQuantity: number;
}

export class BulkInventoryDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @ArrayMaxSize(500)
  @IsUUID('4', { each: true })
  variantIds: string[];

  @IsEnum(BulkInventoryOperation)
  operation: BulkInventoryOperation;

  @IsInt()
  @Min(0)
  quantity: number;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique((item: ExpectedInventoryDto) => item.variantId)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ExpectedInventoryDto)
  expectedInventory: ExpectedInventoryDto[];
}
