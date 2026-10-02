import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
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
 * Input contract for `PATCH /products/:productId/images/:imageId`.
 *
 * `productId` is deliberately absent. Ownership is fixed at creation, and moving
 * an image between products is a domain operation with its own rules rather than
 * a field a caller can overwrite — re-pointing the `product_id` through a
 * generic PATCH would silently relocate an image into another product's gallery,
 * bypassing the primary-image invariant there. A deliberate move will need its
 * own endpoint and its own checks.
 *
 * `id`, `createdAt` and `updatedAt` are absent for the same reason as in the
 * create DTO, and `forbidNonWhitelisted` turns an attempt to send them into a 400.
 *
 * Every field is optional and the rules are repeated rather than inherited, so
 * an update is validated exactly as strictly as a create. The difference
 * between "field omitted" and "field set to `null`" is honoured by the service:
 * an omitted key leaves the column untouched, an explicit `null` clears
 * `altText`.
 *
 * `isPrimary` is accepted but not applied blindly — the service rejects a change
 * that would leave the product with no primary image.
 */
export class UpdateProductImageDto {
  @IsOptional()
  @IsString()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(IMAGE_URL_MAX_LENGTH)
  imageUrl?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(PUBLIC_ID_MAX_LENGTH)
  publicId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(ALT_TEXT_MAX_LENGTH)
  altText?: string | null;

  @IsOptional()
  @IsInt()
  @Min(MIN_SORT_ORDER)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}
