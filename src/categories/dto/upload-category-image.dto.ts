import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Mirrors the `categories` column width so validation bounds the database. */
const ALT_TEXT_MAX_LENGTH = 255;

/**
 * The optional text fields accompanying a multipart category-image upload at
 * `POST /categories/:id/images/upload`.
 *
 * ## Why `imageUrl` and `publicId` are absent
 *
 * These two are produced by Cloudinary and copied into the category record by
 * the service from the upload result. A client that could supply `imageUrl`
 * could point a category at someone else's asset, and a client that could
 * supply `publicId` would control the handle a later replace or delete uses —
 * turning image management into an arbitrary-asset primitive against the
 * Cloudinary account.
 *
 * The global `ValidationPipe` runs with `forbidNonWhitelisted`, so a multipart
 * request that sends either field is rejected with 400 and the upload never
 * starts. This is enforced structurally, by the fields simply not existing.
 */
export class UploadCategoryImageDto {
  @IsOptional()
  @IsString()
  @MaxLength(ALT_TEXT_MAX_LENGTH)
  altText?: string;
}
