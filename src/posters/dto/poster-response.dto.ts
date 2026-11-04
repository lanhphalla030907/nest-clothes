import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class CreatePosterDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  displayOrder?: number;
}

