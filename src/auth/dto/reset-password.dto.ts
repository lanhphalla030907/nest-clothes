import { Transform } from 'class-transformer';
import {
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Match } from './match.decorator.js';

export class ResetPasswordDto {
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MinLength(20)
  @MaxLength(512)
  token: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  newPassword: string;

  @IsString()
  @IsNotEmpty()
  @Match('newPassword', { message: 'Passwords do not match.' })
  confirmPassword: string;
}
