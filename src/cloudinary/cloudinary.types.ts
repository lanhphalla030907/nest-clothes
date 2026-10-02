import { CLOUDINARY_ENV_VARS } from './cloudinary.constants.js';
import type { CloudinaryCredentials } from './cloudinary.config.js';

/**
 * Injection token for the Cloudinary SDK instance.
 *
 * Injecting the SDK itself rather than reaching for the module-level singleton
 * is what makes {@link CloudinaryService} testable: a unit test provides a stub
 * under this token instead of patching a global, so no test can leave the
 * process-wide SDK configured with fake credentials.
 */
export const CLOUDINARY_CLIENT = Symbol('CLOUDINARY_CLIENT');

/**
 * Injection token for the resolved credentials.
 *
 * The service needs them for one reason only: to redact any credential value out
 * of an error message before it propagates. They are injected rather than read
 * from `process.env` at throw time so the redaction is testable and so the
 * validated values are the ones used, not whatever the environment holds later.
 */
export const CLOUDINARY_CREDENTIALS = Symbol('CLOUDINARY_CREDENTIALS');

/**
 * The slice of the Cloudinary uploader API this service depends on.
 *
 * Declaring it structurally — rather than importing the SDK's own interfaces —
 * keeps the service's dependency surface small and makes it obvious which three
 * calls the feature actually makes. Both members are callable with a callback,
 * which is the form the service uses.
 */
export interface CloudinaryClient {
  uploader: {
    upload_stream(
      options: Record<string, unknown>,
      callback: (error: unknown, result: unknown) => void,
    ): NodeJS.WritableStream & { end: (chunk: Buffer) => void };

    destroy(
      publicId: string,
      options: Record<string, unknown>,
      callback: (error: unknown, result: unknown) => void,
    ): void;
  };
}
/**
 * A file handed to {@link CloudinaryService.upload}.
 *
 * A `Buffer` rather than a path or a stream, because the multipart pipeline the
 * next phase will add is configured for in-memory storage: the buffer is already
 * fully read, so the size check is exact and there is no partially-consumed
 * stream to clean up when validation fails.
 */
export interface CloudinaryUploadInput {
  buffer: Buffer;
  mimeType: string;
}

/**
 * The only metadata this feature returns from an upload.
 *
 * Deliberately a closed subset of the SDK's response. The full
 * `UploadApiResponse` also carries `signature`, `api_key`-adjacent delivery
 * details, `original_filename` and moderation output; none of that belongs in a
 * domain object, and forwarding the raw response would make it the caller's
 * problem to notice. `secure_url` is the HTTPS delivery URL, `public_id` is the
 * handle needed to later replace or delete the asset.
 *
 * This is the exact shape the product-image metadata table expects in Phase 4C.
 */
export interface CloudinaryUploadResult {
  secureUrl: string;
  publicId: string;
  width: number;
  height: number;
  format: string;
  bytes: number;
}

export type { CloudinaryCredentials };
export { CLOUDINARY_ENV_VARS };
