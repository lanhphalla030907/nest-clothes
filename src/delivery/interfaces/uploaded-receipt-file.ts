
export interface UploadedReceiptFile {
  /** Filename as declared by the client. Never used; deliberately not trusted. */
  originalname: string;
  /** Size in bytes, per multer. Cross-checked against `buffer.length`. */
  size: number;
  /** Client-declared MIME type. A hint only; Cloudinary re-checks the bytes. */
  mimetype: string;
  /** The decoded bytes, present because storage is in-memory. */
  buffer: Buffer;
}
