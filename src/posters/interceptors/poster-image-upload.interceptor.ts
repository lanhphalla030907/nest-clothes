import { BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  CLOUDINARY_ALLOWED_MIME_TYPES,
  CLOUDINARY_MAX_FILE_SIZE_BYTES,
  isAllowedImageMimeType,
} from '../../cloudinary/cloudinary.constants.js';

/**
 * The multipart form field a poster image must be sent under.
 */
export const POSTER_UPLOAD_FILE_FIELD = 'file';

/**
 * The single multipart boundary for poster-image uploads.
 *
 * `fileFilter` and `limits` reject a bad file while it is still being received,
 * and `CloudinaryService` re-checks both after the file is buffered.
 */
export const PosterImageUploadInterceptor = FileInterceptor(
  POSTER_UPLOAD_FILE_FIELD,
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
