import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** Mirrors the `product_images` column widths so validation bounds the database. */
const IMAGE_URL_MAX_LENGTH = 2048;
const PUBLIC_ID_MAX_LENGTH = 255;
const ALT_TEXT_MAX_LENGTH = 255;

/** The smallest legal display position: `0` is the first image a client renders. */
const MIN_SORT_ORDER = 0;

/**
 * Input contract for `POST /products/:productId/images`.
 *
 * `productId` is required here as well as in the path. The controller takes it
 * from the route, so the body copy is redundant — but it is still validated
 * rather than ignored, which means a client that pastes an image payload from
 * another product gets a 400 instead of silently writing it under the wrong
 * product. The service rejects the two disagreeing.
 *
 * `id`, `createdAt` and `updatedAt` are intentionally absent and the global
 * `ValidationPipe` runs with `forbidNonWhitelisted`, so a client that sends one
 * is rejected with 400 rather than having it silently dropped.
 *
 * `imageUrl` is checked as an absolute URL because the column stores a full
 * address for a remote asset. Only `http`/`https` are accepted: an image record
 * pointing at `javascript:` or `file:` would be stored as data and rendered by
 * a client later.
 *
 * There is no `upload` field and no multipart handling here. This endpoint
 * records metadata that some other process is responsible for producing.
 */
export class CreateProductImageDto {
  @IsUUID()
  productId: string;

  @IsString()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(IMAGE_URL_MAX_LENGTH)
  imageUrl: string;

  /**
   * The image host's own identifier for the asset.
   *
   * Stored now, unused for now. It is what a future delete-or-replace
   * operation will need, because the `imageUrl` may be a transformed CDN URL
   * that no longer identifies the stored asset.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(PUBLIC_ID_MAX_LENGTH)
  publicId: string;

  @IsOptional()
  @IsString()
  @MaxLength(ALT_TEXT_MAX_LENGTH)
  altText?: string;

  /**
   * Display position, lowest first. `0` is the front image.
   *
   * Not unique: several images may share a position, and reads break the tie on
   * `createdAt`.
   */
  @IsOptional()
  @IsInt()
  @Min(MIN_SORT_ORDER)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}
