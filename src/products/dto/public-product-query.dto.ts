import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

export const PUBLIC_SORT_OPTIONS = [
  'newest',
  'price_asc',
  'price_desc',
  'best_selling',
] as const;

export type PublicProductSortOption = (typeof PUBLIC_SORT_OPTIONS)[number];

function IsLessThanOrEqualProperty(
  property: string,
  validationOptions?: ValidationOptions,
) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isLessThanOrEqualProperty',
      target: object.constructor,
      propertyName,
      constraints: [property],
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const [relatedPropertyName] = args.constraints;
          const relatedValue = (args.object as Record<string, unknown>)[relatedPropertyName];
          if (
            value === undefined ||
            value === null ||
            relatedValue === undefined ||
            relatedValue === null
          ) {
            return true;
          }
          if (typeof value !== 'number' || typeof relatedValue !== 'number') {
            return true;
          }
          return value <= relatedValue;
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be less than or equal to ${args.constraints[0]}`;
        },
      },
    });
  };
}

export class PublicProductQueryDto {
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(140)
  category?: string;

  @Type(() => Number)
  @IsOptional()
  @IsNumber()
  @Min(0)
  @IsLessThanOrEqualProperty('maxPrice', {
    message: 'minPrice must be less than or equal to maxPrice',
  })
  minPrice?: number;

  @Type(() => Number)
  @IsOptional()
  @IsNumber()
  @Min(0)
  maxPrice?: number;

  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(100)
  size?: string;

  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(100)
  color?: string;

  @Transform(({ value }) => {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return value;
  })
  @IsOptional()
  @IsBoolean()
  inStock?: boolean;

  @IsOptional()
  @IsString()
  @IsIn(PUBLIC_SORT_OPTIONS, {
    message: `sortBy must be one of: ${PUBLIC_SORT_OPTIONS.join(', ')}`,
  })
  sortBy?: PublicProductSortOption = 'newest';

  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number = 1;

  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 12;
}
