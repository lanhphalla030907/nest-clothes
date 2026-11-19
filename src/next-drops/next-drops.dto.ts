import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsISO8601,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Transport shape for creating or updating a next drop. */
export class CreateNextDropDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  title: string;

  @IsISO8601({ strict: true, strictSeparator: true })
  launchAt: string;

  @IsOptional()
  @IsString()
  collectionId?: string | null;

  @IsOptional()
  @IsString()
  promotionId?: string | null;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  buttonText?: string | null;

  @IsString()
  @IsUrl({
    protocols: ['http', 'https'],
    require_protocol: true,
    require_tld: false,
  }, { message: 'buttonUrl must be a valid URL' })
  buttonUrl: string;

  @IsOptional()
  @IsBoolean()
  isPublished?: boolean;
}

export class UpdateNextDropDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  title?: string;

  @IsOptional()
  @IsString()
  @IsISO8601({ strict: true, strictSeparator: true })
  launchAt?: string;

  @IsOptional()
  @IsString()
  collectionId?: string | null;

  @IsOptional()
  @IsString()
  promotionId?: string | null;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  buttonText?: string | null;

  @IsOptional()
  @IsString()
  @IsUrl({
    protocols: ['http', 'https'],
    require_protocol: true,
    require_tld: false,
  }, { message: 'buttonUrl must be a valid URL' })
  buttonUrl?: string;

  @IsOptional()
  @IsBoolean()
  isPublished?: boolean;
}

export interface NextDropResponseDto {
  id: string;
  title: string;
  launchAt: Date | null;
  collectionId: string | null;
  promotionId: string | null;
  buttonText: string | null;
  buttonUrl: string;
  isPublished: boolean;
  createdAt: Date;
  updatedAt: Date;
  collection?: { id: string; title: string; slug: string; coverImage: string } | null;
  promotion?: { id: string; code: string | null; name: string } | null;
}

export function nextDropResponse(entity: {
  id: string;
  title: string;
  launchAt: Date | null;
  collectionId: string | null;
  promotionId: string | null;
  buttonText: string | null;
  buttonUrl: string;
  isPublished: boolean;
  createdAt: Date;
  updatedAt: Date;
  collection?: { id: string; title: string; slug: string; coverImage: string } | null;
  promotion?: { id: string; code: string | null; name: string } | null;
}): NextDropResponseDto {
  return {
    id: entity.id,
    title: entity.title,
    launchAt: entity.launchAt,
    collectionId: entity.collectionId,
    promotionId: entity.promotionId,
    buttonText: entity.buttonText,
    buttonUrl: entity.buttonUrl,
    isPublished: entity.isPublished,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
    collection: entity.collection ?? null,
    promotion: entity.promotion ?? null,
  };
}
