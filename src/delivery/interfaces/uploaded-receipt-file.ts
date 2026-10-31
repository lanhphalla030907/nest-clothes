/**
 * The parts of a multipart receipt upload this feature reads.
 *
 * Declared locally, like the product-image upload contract, so the delivery
 * feature depends on exactly the fields it uses. `buffer` is present because
 * multer is configured for in-memory storage; no temporary file is written to
 * disk at any point in the request.
 */
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
