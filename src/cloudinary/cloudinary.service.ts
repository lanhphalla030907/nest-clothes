import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import {
  CLOUDINARY_ALLOWED_FORMATS,
  CLOUDINARY_ALLOWED_MIME_TYPES,
  CLOUDINARY_MAX_FILE_SIZE_BYTES,
  CLOUDINARY_RESOURCE_TYPE,
  CLOUDINARY_UPLOAD_FOLDER,
  isAllowedImageMimeType,
} from './cloudinary.constants.js';
import {
  CLOUDINARY_CLIENT,
  CLOUDINARY_CREDENTIALS,
  type CloudinaryClient,
  type CloudinaryCredentials,
  type CloudinaryUploadInput,
  type CloudinaryUploadResult,
} from './cloudinary.types.js';

/**
 * Owns every interaction with Cloudinary.
 *
 * The service is the only place in the codebase that knows the Cloudinary SDK
 * exists. Callers hand it an in-memory buffer and receive a closed metadata
 * shape; no URL is constructed by hand, no upload option is exposed to the
 * caller, and no credential ever leaves this file.
 *
 * ## Why the buffer API
 *
 * Uploads go through `upload_stream` fed from a `Buffer` rather than
 * `cloudinary.uploader.upload(path)`. That matches a multipart pipeline
 * configured for in-memory storage, which is what the upload endpoint will use, so
 * no temporary file is ever written to disk and there is no half-consumed stream
 * to clean up when validation rejects a request. It also makes the size check
 * exact: the byte length is already known before a single byte is sent.
 *
 * ## Validation is enforced twice, deliberately
 *
 * The MIME type and size are checked here so a bad request costs nothing, *and*
 * `resource_type`/`allowed_formats` are pinned on the upload options so Cloudinary
 * checks the real content after inspecting the file. A client-declared MIME type
 * is only a hint; the remote check is the one that cannot be lied to.
 *
 * ## Error semantics
 *
 * | Condition                                   | Status | Rationale                                      |
 * | ------------------------------------------- | ------ | ---------------------------------------------- |
 * | Buffer is empty or over the size limit      | 400    | The request is malformed; nothing was sent.    |
 * | MIME type not in the allow-list             | 400    | The request is not an accepted image.          |
 * | Cloudinary rejects the upload               | 500    | A remote or configuration fault, not the caller's. |
 * | Cloudinary rejects the delete               | 500    | Same; the caller cannot fix it by retrying.   |
 *
 * A delete that finds nothing is treated as success. Cloudinary's `destroy` is
 * already idempotent, and reporting a missing asset as an error would make a
 * retried cleanup fail on the second attempt.
 *
 * ## Secret handling
 *
 * No credential is ever placed in a return value, an error message or a log line.
 * Upstream SDK errors *can* echo a configured value back in their text, so every
 * message crossing this boundary is passed through {@link redactSecrets} first.
 */
@Injectable()
export class CloudinaryService {
  private readonly logger = new Logger(CloudinaryService.name);

  constructor(
    @Inject(CLOUDINARY_CLIENT) private readonly client: CloudinaryClient,
    @Inject(CLOUDINARY_CREDENTIALS)
    private readonly credentials: CloudinaryCredentials,
  ) {}

  /**
   * Uploads one image from an in-memory buffer.
   *
   * @returns the safe metadata a product-image record needs, and nothing else.
   * @throws BadRequestException when the buffer is empty, oversized, or not an
   * accepted image type. Nothing is sent to Cloudinary in those cases.
   */
  async upload(input: CloudinaryUploadInput): Promise<CloudinaryUploadResult> {
    this.assertBufferIsPresent(input.buffer);
    this.assertWithinSizeLimit(input.buffer);
    this.assertMimeTypeIsAllowed(input.mimeType);

    const response = await this.runUpload(input.buffer);

    return this.toUploadResult(response);
  }

  /**
   * Deletes the asset identified by `publicId`.
   *
   * @returns `true` once Cloudinary reports the asset gone. Deleting an asset
   * that no longer exists also resolves to `true` — the caller's intent, that the
   * asset is absent, is satisfied either way.
   * @throws InternalServerErrorException when Cloudinary reports a failure.
   */
  async deleteAsset(publicId: string): Promise<boolean> {
    this.assertPublicIdIsPresent(publicId);

    await this.runDelete(publicId);

    return true;
  }

  /** Rejects a missing or empty buffer before any work is attempted. */
  private assertBufferIsPresent(buffer: Buffer): void {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new BadRequestException('Image file is empty');
    }
  }

  /**
   * Rejects a file over the configured limit.
   *
   * Checked here rather than delegated to Cloudinary so an oversized upload is
   * refused without a round trip, and so the limit is an application rule that
   * does not silently change with the Cloudinary plan.
   */
  private assertWithinSizeLimit(buffer: Buffer): void {
    if (buffer.length > CLOUDINARY_MAX_FILE_SIZE_BYTES) {
      throw new BadRequestException(
        `Image file exceeds the maximum size of ${CLOUDINARY_MAX_FILE_SIZE_BYTES} bytes`,
      );
    }
  }

  /**
   * Rejects a MIME type outside the allow-list.
   *
   * The comparison itself lives in {@link isAllowedImageMimeType} so the multipart
   * `fileFilter` that rejects a bad file *before* it is buffered decides on
   * exactly the same list; this guard is the second of the two gates, and it is
   * the one that holds when the service is called without going through HTTP.
   */
  private assertMimeTypeIsAllowed(mimeType: string): void {
    if (isAllowedImageMimeType(mimeType)) {
      return;
    }

    throw new BadRequestException(
      `Unsupported image type. Allowed types: ${CLOUDINARY_ALLOWED_MIME_TYPES.join(', ')}`,
    );
  }

  private assertPublicIdIsPresent(publicId: string): void {
    if (typeof publicId !== 'string' || publicId.trim().length === 0) {
      throw new BadRequestException('publicId is required');
    }
  }

  /**
   * Streams the buffer to Cloudinary and resolves with the raw SDK response.
   *
   * Three failure paths are folded into one promise, because the callback form
   * only covers one of them and the other two would otherwise escape as an
   * unhandled error rather than a rejected request:
   *
   * - the SDK invoking the callback with an error,
   * - the stream emitting `error` while the buffer is being written,
   * - `upload_stream` or `end` throwing synchronously.
   *
   * `end` alone is not enough: once a writable has been handed to an HTTP
   * transport, a transport-level failure surfaces as an `error` event and the
   * callback may never be invoked at all.
   */
  private runUpload(buffer: Buffer): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      try {
        const stream = this.client.uploader.upload_stream(
          {
            folder: CLOUDINARY_UPLOAD_FOLDER,
            resource_type: CLOUDINARY_RESOURCE_TYPE,
            allowed_formats: [...CLOUDINARY_ALLOWED_FORMATS],
            /**
             * `overwrite: false` makes a repeated upload of the same bytes produce a
             * distinct asset instead of silently replacing one a product image row
             * may still reference. Callers that intend to replace pass an explicit
             * `public_id` in Phase 4C.
             */
            overwrite: false,
          },
          (error: unknown, result: unknown) => {
            if (error) {
              reject(this.toUploadFailure(error));

              return;
            }

            resolve(result as Record<string, unknown>);
          },
        );

        stream.once('error', (error: unknown) => {
          reject(this.toUploadFailure(error));
        });

        stream.end(buffer);
      } catch (error) {
        reject(this.toUploadFailure(error));
      }
    });
  }

  /**
   * Deletes an asset and resolves once Cloudinary confirms.
   *
   * Cloudinary answers "not found" with an error carrying a 404 code. That is the
   * desired end state, not a failure, so it resolves instead of rejecting and a
   * retried cleanup stays idempotent.
   */
  private runDelete(publicId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client.uploader.destroy(
        publicId,
        { resource_type: CLOUDINARY_RESOURCE_TYPE, invalidate: true },
        (error: unknown) => {
          if (error && !this.isNotFound(error)) {
            reject(this.toDeleteFailure(publicId, error));

            return;
          }

          resolve();
        },
      );
    });
  }

  /** Whether an SDK error means the asset was already absent. */
  private isNotFound(error: unknown): boolean {
    const code = (error as { http_code?: number } | null)?.http_code;

    return code === 404;
  }

  /**
   * Builds the client-facing failure for an upload, with no credential in it.
   *
   * The SDK's own message is included because it is the only actionable detail
   * ("File size too large", "Invalid API key"), but it is redacted first: some
   * upstream errors quote the configuration back, and that text can end up in a
   * log or an error tracker.
   */
  private toUploadFailure(error: unknown): InternalServerErrorException {
    const detail = this.extractSafeDetail(error);

    this.logger.error(`Cloudinary upload failed: ${detail}`);

    return new InternalServerErrorException(
      `Image upload failed${detail ? `: ${detail}` : ''}`,
    );
  }

  /** Client-facing failure for a delete, likewise redacted. */
  private toDeleteFailure(
    publicId: string,
    error: unknown,
  ): InternalServerErrorException {
    const detail = this.extractSafeDetail(error);

    this.logger.error(`Cloudinary delete failed for ${publicId}: ${detail}`);

    return new InternalServerErrorException(
      `Image deletion failed${detail ? `: ${detail}` : ''}`,
    );
  }

  /**
   * Extracts an upstream message and strips every credential value from it.
   *
   * A fixed replacement is used rather than a truncation, so the message cannot
   * leak a partial secret either.
   */
  private extractSafeDetail(error: unknown): string {
    if (error === null || error === undefined) {
      return '';
    }

    const message =
      typeof error === 'string'
        ? error
        : ((error as { message?: unknown }).message ?? '');

    if (typeof message !== 'string' || message.length === 0) {
      return '';
    }

    return this.redactSecrets(message);
  }

  /**
   * Replaces any configured credential appearing in `text` with a placeholder.
   *
   * The values are matched literally and every occurrence is replaced, so neither
   * the API secret nor the API key nor the cloud name can survive into a message.
   * The replacement text deliberately does not hint at the value's length.
   */
  private redactSecrets(text: string): string {
    let safe = text;

    for (const secret of [
      this.credentials.apiSecret,
      this.credentials.apiKey,
      this.credentials.cloudName,
    ]) {
      if (typeof secret === 'string' && secret.length > 0) {
        safe = safe.split(secret).join('[redacted]');
      }
    }

    return safe;
  }

  /**
   * Projects the raw SDK response onto the six fields this feature exposes.
   *
   * Every field is coerced defensively: the SDK types the response as fully
   * populated, but a partial response must not become `undefined` in a domain
   * object that the next phase will persist verbatim. A missing value surfaces
   * as `0` or `''`, which fails loudly at the point of use rather than silently
   * writing a null into a non-null column.
   */
  private toUploadResult(
    response: Record<string, unknown>,
  ): CloudinaryUploadResult {
    return {
      secureUrl: String(response['secure_url'] ?? ''),
      publicId: String(response['public_id'] ?? ''),
      width: Number(response['width'] ?? 0),
      height: Number(response['height'] ?? 0),
      format: String(response['format'] ?? ''),
      bytes: Number(response['bytes'] ?? 0),
    };
  }
}
