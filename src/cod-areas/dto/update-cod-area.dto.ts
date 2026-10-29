import { Transform } from 'class-transformer';
import { IsBoolean, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';

const NAME_MAX_LENGTH = 120;

export class UpdateCodAreaDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(NAME_MAX_LENGTH)
  name?: string;

  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean()
  codEnabled?: boolean;
}
