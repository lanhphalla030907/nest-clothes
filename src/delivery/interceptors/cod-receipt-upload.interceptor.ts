import { BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  CLOUDINARY_ALLOWED_MIME_TYPES,
  CLOUDINARY_MAX_FILE_SIZE_BYTES,
  isAllowedImageMimeType,
} from '../../cloudinary/cloudinary.constants.js';

/**
 * The multipart form field a COD receipt must be sent under.
 *
 * A named field rather than "any file", so the service never has to guess which
 * part of the request is the receipt.
 */
export const COD_RECEIPT_FILE_FIELD = 'receiptProof';

/**
 * The one multipart boundary for COD receipt uploads.
 *
 * The field name, MIME allow-list and size ceiling are shared with the existing
 * product-image upload path by sourcing them from the same Cloudinary constants.
 * A bad file is rejected while it is still being received, and
 * `CloudinaryService` re-checks the buffer before anything is sent upstream.
 */
export const CodReceiptUploadInterceptor = FileInterceptor(
  COD_RECEIPT_FILE_FIELD,
  {
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
  },
);
