import { Transform, type TransformFnParams } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/** Mirrors the `product_images` column width so validation bounds the database. */
const ALT_TEXT_MAX_LENGTH = 255;

/** The smallest legal display position: `0` is the first image a client renders. */
const MIN_SORT_ORDER = 0;

/**
 * Coerces a multipart text field to a number.
 *
 * ## Why this decorator is not optional
 *
 * Every value in a `multipart/form-data` body arrives as a **string**. Unlike a
 * JSON body — where `sortOrder: 2` is already a number — a form can only carry
 * `"2"`, and the global `ValidationPipe` is configured with `transform: true` but
 * *not* `enableImplicitConversion`, so nothing converts it on the way in. Without
 * this, `@IsInt()` would reject every multipart upload that sets a display
 * position: the field is a string, the rule wants a number, and the request fails
 * with a 400 that looks nothing like its cause.
 *
 * Unparseable input is deliberately returned **unchanged** rather than coerced to
 * `NaN` or `0`. `Number('abc')` is `NaN` and `Number('')` is `0`, both of which
 * would turn a malformed field into either a confusing rule failure or a silently
 * accepted zero. Leaving the string in place lets `@IsInt()` reject it with a 400
 * that names the offending field, which is the honest outcome.
 */
const toInteger = ({ value }: TransformFnParams): unknown => {
  if (typeof value === 'number') {
    return value;
  }

  if (typeof value !== 'string' || value.trim().length === 0) {
    return value;
  }

  const parsed = Number(value);

  return Number.isNaN(parsed) ? value : parsed;
};

/**
 * Coerces a multipart text field to a boolean.
 *
 * The explicit `true`/`false`/`1`/`0` mapping is the whole reason this is not
 * `@Type(() => Boolean)`: JavaScript's `Boolean('false')` is `true`, so the naive
 * coercion would read a client that explicitly sent `isPrimary=false` as a request
 * to make the image primary — the exact opposite of what it asked for, and one that
 * silently demotes the product's existing primary image.
 *
 * Anything else is passed through so `@IsBoolean()` rejects it, rather than being
 * read as a convenient `false`.
 */
const toBoolean = ({ value }: TransformFnParams): unknown => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (value === 'true' || value === '1') {
    return true;
  }

  if (value === 'false' || value === '0') {
    return false;
  }

  return value;
};

/**
 * The optional text fields accompanying a multipart upload at
 * `POST /products/:productId/images/upload`.
 *
 * ## Why `imageUrl` and `publicId` are absent
 *
 * These two are the whole point of the route and are the reason it exists. On an
 * upload both are produced by Cloudinary and are copied into the row by the
 * service from the upload result; a client that could supply them would be able to
 * point a product's gallery at someone else's asset, and a client that could
 * supply `publicId` would control the handle a later delete uses — turning delete
 * into an arbitrary-asset-deletion primitive against the Cloudinary account.
 *
 * The global `ValidationPipe` runs with `forbidNonWhitelisted`, so a multipart
 * request that *does* send either field is rejected with 400 and the upload never
 * starts. This is enforced structurally, by the fields simply not existing, rather
 * than by a rule that strips them and carries on.
 *
 * `productId` is absent for the same reason `CreateProductImageDto` requires it:
 * ownership comes from the path, and a body copy could only ever contradict it.
 */
export class UploadProductImageDto {
  @IsOptional()
  @IsString()
  @MaxLength(ALT_TEXT_MAX_LENGTH)
  altText?: string;

  /**
   * Display position, lowest first. `0` is the front image.
   *
   * Optional, and defaults to `0` server-side. The `@Transform` is required because
   * a multipart value arrives as a string — see {@link toInteger}.
   */
  @IsOptional()
  @Transform(toInteger)
  @IsInt()
  @Min(MIN_SORT_ORDER)
  sortOrder?: number;

  /**
   * Whether this upload becomes the product's primary image.
   *
   * Opt-in rather than automatic, so uploading a gallery of five images does not
   * silently promote whichever landed last. The single-primary invariant is
   * enforced by the service and the partial unique index, not by this flag.
   *
   * The `@Transform` is required because a multipart value arrives as a string,
   * and the naive `Boolean()` coercion inverts an explicit `false` — see
   * {@link toBoolean}.
   */
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  isPrimary?: boolean;
}
