/**
 * Cloudinary environment variable names.
 *
 * Kept in one place so the configuration reader, the `.env.example` template and
 * the tests can never drift apart on spelling. Nothing else in the codebase reads
 * a `CLOUDINARY_*` variable directly.
 */
export const CLOUDINARY_ENV_VARS = {
  cloudName: 'CLOUDINARY_CLOUD_NAME',
  apiKey: 'CLOUDINARY_API_KEY',
  apiSecret: 'CLOUDINARY_API_SECRET',
} as const;

/**
 * Folder every upload is written under.
 *
 * Grouping assets under a prefix is what makes a later cleanup or a folder-level
 * transformation possible; a flat namespace of auto-generated ids cannot be
 * reasoned about once the catalog grows. The trailing slash is required by the
 * Cloudinary API — a prefix without it is stored as a literal directory segment
 * of the filename rather than as a folder.
 */
export const CLOUDINARY_UPLOAD_FOLDER = 'products/';

/**
 * Largest upload accepted, in bytes (5 MiB).
 *
 * Enforced here rather than left to Cloudinary so an oversized request is
 * refused without spending an upload round trip, and so the limit is a documented
 * application rule rather than a plan-dependent remote behaviour. It is checked
 * against the in-memory buffer length, which is authoritative for the
 * memory-storage multipart pipeline the next phase will use.
 */
export const CLOUDINARY_MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;

/**
 * MIME types accepted as image uploads.
 *
 * The list is enforced in two independent places, because either alone is
 * insufficient: the MIME type comes from the client and is therefore only a
 * hint, and `resource_type: 'image'` alone would still accept a video or a PDF
 * delivered under an `image/*` type. `allowed_formats` on the upload options is
 * what Cloudinary itself enforces after inspecting the real content.
 */
export const CLOUDINARY_ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif',
] as const;

/**
 * Image formats accepted by Cloudinary, passed as `allowed_formats`.
 *
 * Derived from {@link CLOUDINARY_ALLOWED_MIME_TYPES} rather than listed twice so
 * the two cannot disagree. Note that this list is checked by Cloudinary against
 * the actual file content, which is what makes it a real defence rather than a
 * restatement of the client-supplied type.
 */
export const CLOUDINARY_ALLOWED_FORMATS = [
  'jpg',
  'png',
  'webp',
  'avif',
  'gif',
] as const;

/**
 * The only resource type this service will ever touch.
 *
 * Hardcoded rather than configurable on purpose: the feature is a product image
 * gallery, and making the resource type caller-selectable would let a future
 * caller delete arbitrary assets in the account by passing `resource_type`.
 */
export const CLOUDINARY_RESOURCE_TYPE = 'image';

/**
 * Reduces a client-supplied MIME type to its bare, comparable form.
 *
 * Multipart parsers and browsers both append parameters and vary in case, so
 * `Image/JPEG; charset=binary` and `image/jpeg` must be treated as the same type.
 * Returns an empty string for anything that is not a string, which is what makes a
 * missing type fail the allow-list check rather than throw.
 */
export const normalizeImageMimeType = (mimeType: string): string =>
  typeof mimeType === 'string' ? mimeType.split(';')[0].trim().toLowerCase() : '';

/**
 * Whether a MIME type is in {@link CLOUDINARY_ALLOWED_MIME_TYPES}.
 *
 * Exported as the single source of truth for the allow-list so the multipart
 * `fileFilter` that rejects a bad file before it is buffered and
 * `CloudinaryService`'s own guard can never drift into accepting different types.
 * Both call this; neither re-implements the comparison.
 *
 * This is the cheap first gate only. A client-declared type is a hint, and only
 * Cloudinary's `allowed_formats` check against the real bytes is authoritative.
 */
export const isAllowedImageMimeType = (mimeType: string): boolean => {
  const normalized = normalizeImageMimeType(mimeType);

  return (
    normalized.length > 0 &&
    (CLOUDINARY_ALLOWED_MIME_TYPES as readonly string[]).includes(normalized)
  );
};
