import { BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CLOUDINARY_ALLOWED_MIME_TYPES, CLOUDINARY_MAX_FILE_SIZE_BYTES, isAllowedImageMimeType } from '../../cloudinary/cloudinary.constants.js';

export const COLLECTION_UPLOAD_FILE_FIELD = 'file';

export const CollectionImageUploadInterceptor = FileInterceptor(COLLECTION_UPLOAD_FILE_FIELD, {
  limits: { fileSize: CLOUDINARY_MAX_FILE_SIZE_BYTES },
  fileFilter: (_request: unknown, file: { mimetype: string }, callback: (error: Error | null, acceptFile: boolean) => void) => {
    if (!isAllowedImageMimeType(file.mimetype)) {
      callback(new BadRequestException(`Unsupported image type. Allowed types: ${CLOUDINARY_ALLOWED_MIME_TYPES.join(', ')}`), false);
      return;
    }
    callback(null, true);
  },
});
