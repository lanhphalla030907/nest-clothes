import { BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  CLOUDINARY_ALLOWED_MIME_TYPES,
  CLOUDINARY_MAX_FILE_SIZE_BYTES,
  isAllowedImageMimeType,
} from '../../cloudinary/cloudinary.constants.js';

/**
 * The multipart form field the image must be sent under.
 *
 * A named field rather than "any file": `AnyFilesInterceptor` would accept a file under
 * an arbitrary key and then leave the service guessing which one to upload.
 */
export const UPLOAD_FILE_FIELD = 'file';

/**
 * The one multipart boundary for product-image uploads.
 *
 * A shared interceptor rather than inline configuration on each controller, so there is
 * a single place where an upload is admitted: the field name, the allowed MIME types and
 * the size ceiling cannot drift between the public route and the administrative one.
 * Both limits are sourced from the Cloudinary constants rather than restated, so they
 * cannot drift from the service's own rules either.
 *
 * `fileFilter` and `limits` reject a bad file while it is still being received, so an
 * oversized or non-image payload never reaches memory in full and never reaches
 * Cloudinary. `CloudinaryService` re-checks both after the file is buffered — that second
 * gate is what holds for a direct service call — and it is the one that inspects the
 * actual bytes via Cloudinary's `allowed_formats`.
 */
export const ProductImageUploadInterceptor = FileInterceptor(UPLOAD_FILE_FIELD, {
  limits: { fileSize: CLOUDINARY_MAX_FILE_SIZE_BYTES },
  fileFilter: (
    _request: unknown,
    file: { mimetype: string },
    callback: (error: Error | null, acceptFile: boolean) => void,
  ) => {
    if (!isAllowedImageMimeType(file.mimetype)) {
      callback(
        new BadRequestException(
          `Unsupported image type. Allowed types: ${CLOUDINARY_ALLOWED_MIME_TYPES.join(', ')}`,
        ),
        false,
      );

      return;
    }

    callback(null, true);
  },
});