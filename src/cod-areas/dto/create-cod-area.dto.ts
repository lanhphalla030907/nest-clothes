import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

const CODE_PATTERN = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const CODE_MAX_LENGTH = 50;
const NAME_MAX_LENGTH = 120;

export class CreateCodAreaDto {
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(CODE_MAX_LENGTH)
  @Matches(CODE_PATTERN, {
    message:
      'code must contain uppercase letters or numbers separated by single hyphens',
  })
  code: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(NAME_MAX_LENGTH)
  name: string;

  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean()
  codEnabled?: boolean;
}
