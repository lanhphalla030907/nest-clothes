/**
 * The parts of a multipart upload this feature reads.
 *
 * Declared locally rather than pulled from `@types/multer` so the dependency
 * surface of the product-images feature is exactly the four fields it uses, and so
 * a multer upgrade cannot silently widen what the service is handed.
 *
 * `buffer` is only present because multer is configured for in-memory storage —
 * that is the reason `CloudinaryService` accepts a `Buffer`, and it means no
 * temporary file is written to disk at any point in the request.
 */
export interface UploadedImageFile {
  /** Filename as declared by the client. Never used; deliberately not trusted. */
  originalname: string;
  /** Size in bytes, per multer. Cross-checked against `buffer.length`. */
  size: number;
  /** Client-declared MIME type. A hint only — never the sole basis for a decision. */
  mimetype: string;
  /** The decoded bytes, present because storage is in-memory. */
  buffer: Buffer;
}
