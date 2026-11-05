import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { toDisplayOrder } from './display-order.transform.js';

export class UploadPosterImageDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @IsOptional()
  @Transform(toDisplayOrder)
  @IsInt()
  @Min(0)
  displayOrder?: number;
}
