import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CloudinaryService } from '../cloudinary/cloudinary.service.js';
import type { ProductImage } from '../generated/prisma/client.js';
import { ProductsRepository } from '../products/repositories/products.repository.js';
import { CreateProductImageDto } from './dto/create-product-image.dto.js';
import { ProductImageResponseDto } from './dto/product-image-response.dto.js';
import { UpdateProductImageDto } from './dto/update-product-image.dto.js';
import { UploadProductImageDto } from './dto/upload-product-image.dto.js';
import type { UploadedImageFile } from './interfaces/uploaded-image-file.js';
import {
  ProductImagesRepository,
  type CreateProductImageData,
  type UpdateProductImageData,
} from './repositories/product-images.repository.js';

/** The display position a new image gets when the caller does not choose one. */
const DEFAULT_SORT_ORDER = 0;

/** A new image is not the primary one unless the caller explicitly says so. */
const DEFAULT_IS_PRIMARY = false;

const CANNOT_CLEAR_PRIMARY_MESSAGE =
  'The only primary image of a product cannot be cleared; promote another image first';
const CANNOT_DELETE_PRIMARY_MESSAGE =
  'The primary image of a product cannot be deleted; promote another image first';
/**
 * All product-image business rules live here; the repository only knows about SQL
 * and the controller only knows about HTTP.
 *
 * ## Primary image invariant
 *
 * A product has **at most one** primary image. Three layers enforce it, each
 * covering the weakness of the one before it:
 *
 * 1. These service rules, which give a deterministic answer to every well-formed
 *    request. Promoting is a swap: the incumbent is demoted and the newcomer is
 *    promoted in one transaction, so the product never passes through a state
 *    with two primaries or none.
 * 2. A PostgreSQL partial unique index on `(product_id) WHERE is_primary = true`,
 *    declared in the migration. Two concurrent promotions can both pass the
 *    service's reads; only the index can settle that race, and it rejects the
 *    loser rather than silently storing two primaries.
 * 3. The database itself, which cannot be written to by any other path.
 *
 * The service also refuses two operations outright rather than repairing them:
 * clearing the flag on the current primary, and deleting the current primary.
 * Both would leave a product that has one with no primary image, and silently
 * choosing a replacement would hide a decision the caller should make. A caller
 * that disagrees promotes a different image first, then does what it wanted.
 *
 * ## Error semantics
 *
 * The mapping below is the only place where a condition becomes an HTTP one.
 * Anything not listed propagates untouched, so genuine faults are never
 * disguised as client errors.
 *
 * | Condition                                    | Status | Rationale                                                        |
 * | -------------------------------------------- | ------ | ---------------------------------------------------------------- |
 * | Malformed UUID in path or body               | 400    | Rejected by `ParseUUIDPipe` / the DTO validators.                 |
 * | Invalid URL, negative `sortOrder`            | 400    | Rejected by the DTO validators.                                  |
 * | `productId` in body disagrees with the path  | 400    | Contradictory request; nothing was addressed unambiguously.       |
 * | Product does not exist                       | 404    | The addressed resource is absent.                                |
 * | Image does not exist                         | 404    | The addressed resource is absent.                                |
 * | Image belongs to a different product         | 404    | Deliberately indistinguishable from "absent" — see below.         |
 * | Clear or delete the only primary image       | 409    | Valid target, but it conflicts with the current state.            |
 *
 * ## Ownership
 *
 * `/products/:productId/images/:imageId` addresses an image *through its
 * product*. An image reached through the wrong product is reported as 404 rather
 * than 403: telling the caller that the id exists but is not theirs confirms the
 * existence of another product's asset, which is exactly what the nested route is
 * meant to scope away.
 *
 * ## Cross-aggregate reads
 *
 * Product existence is checked through `ProductsRepository`, never by querying
 * `products` from this feature's repository, so no SQL for the Product aggregate
 * is duplicated and no circular dependency is introduced: the edge runs
 * ProductImages -> Products only.
 *
 * Note what is deliberately *not* checked here: that the product is active. An
 * image is editable metadata regardless of the product's visibility, and tying
 * image writes to product lifecycle would make unpublished products impossible
 * to prepare.
 *
 * ## Cloudinary and the database cannot share a transaction
 *
 * `CloudinaryService` is a remote system and this repository is a local one, so
 * there is no way to make an upload and its row atomic. The two methods that span
 * both therefore state their ordering and their failure mode explicitly:
 *
 * - `upload` writes the asset first and the row second, because a row needs the
 *   `publicId` Cloudinary produces and cannot be written before it exists. A failed
 *   insert is compensated by deleting the asset.
 * - `remove` deletes the asset first and the row second, because the row is the
 *   only record of the `publicId`. A failed row delete leaves a visible, repairable
 *   orphan rather than an asset nobody can find.
 *
 * Neither ordering is free of a failure mode; each picks the one that can still be
 * diagnosed. `CloudinaryService` is injected rather than configured here, so this
 * feature never sees a credential and the boundary stays a single class wide.
 */
@Injectable()
export class ProductImagesService {
  private readonly logger = new Logger(ProductImagesService.name);

  constructor(
    private readonly productImagesRepository: ProductImagesRepository,
    private readonly productsRepository: ProductsRepository,
    private readonly cloudinaryService: CloudinaryService,
  ) {}

  /**
   * Uploads a file for `productId` and records it as a product image.
   *
   * The order of operations is the whole design here, because a remote call and a
   * local write cannot share a transaction and one of them can fail alone:
   *
   * 1. The product is confirmed to exist — before anything is uploaded, so a typo
   *    in the path costs a database read rather than a wasted asset.
   * 2. The file is validated by `CloudinaryService`, which refuses an empty,
   *    oversized or non-image payload before a single byte leaves the process.
   * 3. The bytes go to Cloudinary.
   * 4. `imageUrl` and `publicId` are read **off the upload result**, never off the
   *    request. The client has no way to influence either.
   * 5. The row is inserted, through the same `createAsPrimary` path as the metadata
   *    route so the single-primary invariant behaves identically.
   * 6. If step 5 throws, the asset uploaded in step 3 is deleted before the error
   *    propagates. See {@link compensateFailedUpload}.
   *
   * A file is required: an upload with no `file` part is a 400 rather than a row
   * with no image, because `imageUrl` is non-nullable and there is nothing
   * meaningful to store.
   */
  async upload(
    productId: string,
    file: UploadedImageFile | undefined,
    dto: UploadProductImageDto = {},
  ): Promise<ProductImageResponseDto> {
    await this.requireProduct(productId);
    const uploadedFile = this.assertFileIsPresent(file);

    const uploaded = await this.cloudinaryService.upload({
      buffer: uploadedFile.buffer,
      mimeType: uploadedFile.mimetype,
    });

    const data: CreateProductImageData = {
      productId,
      /**
       * Both values come from Cloudinary's response. `secureUrl` is the HTTPS
       * delivery address and `publicId` is the handle a later replace or delete
       * uses, so a client cannot forge either one.
       */
      imageUrl: uploaded.secureUrl,
      publicId: uploaded.publicId,
      altText: this.normalizeAltText(dto.altText),
      sortOrder: dto.sortOrder ?? DEFAULT_SORT_ORDER,
      isPrimary: dto.isPrimary ?? DEFAULT_IS_PRIMARY,
    };

    let image: ProductImage;

    try {
      image = data.isPrimary
        ? await this.productImagesRepository.createAsPrimary(data)
        : await this.productImagesRepository.create(data);
    } catch (error) {
      await this.compensateFailedUpload(uploaded.publicId, error);

      throw error;
    }

    return ProductImageResponseDto.fromEntity(image);
  }

  /**
   * Deletes a Cloudinary asset and its metadata row.
   *
   * The order is the reverse of upload and is deliberately **not** reversed by the
   * caller: Cloudinary first, database second.
   *
   * Deleting the row first would make the asset unreclaimable — the row is the
   * only record of the `publicId`, so once it is gone nothing knows which asset to
   * clean up, and an orphaned file would sit in the account billing storage
   * forever. Deleting the asset first means the worst case of a database failure is
   * a row pointing at an absent asset, which is visible and repairable; the worst
   * case of the other order is invisible and permanent.
   *
   * A Cloudinary failure therefore aborts the delete and leaves the row exactly as
   * it was, so a retried request still has the `publicId` it needs.
   *
   * The primary-image refusal is unchanged from the metadata-only phase and is
   * checked *before* the remote call, so a 409 never deletes anything.
   */
  async remove(productId: string, imageId: string): Promise<void> {
    const image = await this.requireOwnedImage(productId, imageId);

    if (image.isPrimary) {
      throw new ConflictException(CANNOT_DELETE_PRIMARY_MESSAGE);
    }

    /**
     * Propagates as a 500 on failure, which is the correct signal: the asset is
     * still in the account, so this is an operational fault rather than a bad
     * request, and `ProductImagesRepository.delete` is never reached.
     */
    await this.cloudinaryService.deleteAsset(image.publicId);

    await this.productImagesRepository.delete(imageId);
  }

  async create(
    productId: string,
    dto: CreateProductImageDto,
  ): Promise<ProductImageResponseDto> {
    this.assertBodyMatchesPath(productId, dto.productId);
    await this.requireProduct(productId);

    const data: CreateProductImageData = {
      productId,
      imageUrl: dto.imageUrl.trim(),
      publicId: dto.publicId.trim(),
      altText: this.normalizeAltText(dto.altText),
      sortOrder: dto.sortOrder ?? DEFAULT_SORT_ORDER,
      isPrimary: dto.isPrimary ?? DEFAULT_IS_PRIMARY,
    };

    const image = data.isPrimary
      ? await this.productImagesRepository.createAsPrimary(data)
      : await this.productImagesRepository.create(data);

    return ProductImageResponseDto.fromEntity(image);
  }

  async findAllByProductId(
    productId: string,
  ): Promise<ProductImageResponseDto[]> {
    await this.requireProduct(productId);

    const images =
      await this.productImagesRepository.findAllByProductId(productId);

    return images.map((image) => ProductImageResponseDto.fromEntity(image));
  }

  async findOne(
    productId: string,
    imageId: string,
  ): Promise<ProductImageResponseDto> {
    const image = await this.requireOwnedImage(productId, imageId);

    return ProductImageResponseDto.fromEntity(image);
  }

  async update(
    productId: string,
    imageId: string,
    dto: UpdateProductImageDto,
  ): Promise<ProductImageResponseDto> {
    const image = await this.requireOwnedImage(productId, imageId);
    const data = this.buildUpdateData(dto);

    /**
     * Promotion is the only path that touches the incumbent: `updateAsPrimary`
     * demotes the current primary and writes this row's columns in the same
     * transaction, so the product is never briefly without a primary.
     *
     * An image that is *already* primary skips this branch: demoting and
     * re-promoting it would be a no-op that still writes the row.
     */
    if (dto.isPrimary === true && !image.isPrimary) {
      const updated = await this.productImagesRepository.updateAsPrimary(
        imageId,
        productId,
        data,
      );

      return ProductImageResponseDto.fromEntity(updated);
    }

    if (dto.isPrimary === false) {
      await this.assertPrimaryCanBeDemoted(image);

      /**
       * `isPrimary` is written explicitly rather than left to `buildUpdateData`.
       * A PATCH whose only field is `isPrimary: false` on the *current* primary
       * still has to reach the database, and this is the only legitimate way the
       * flag moves without `updateAsPrimary`. The invariant just cleared is what
       * makes it safe: the product keeps a primary because another image holds it.
       *
       * When the image was already not primary there is nothing to clear, so the
       * flag is left out and the no-op short-circuit below applies.
       */
      if (image.isPrimary) {
        data.isPrimary = false;
      }
    }

    /**
     * Nothing to write. Returning the loaded row keeps a no-op request from
     * bumping `updatedAt` and re-locking the row for no reason.
     */
    if (Object.keys(data).length === 0) {
      return ProductImageResponseDto.fromEntity(image);
    }

    const updated = await this.productImagesRepository.update(imageId, data);

    return ProductImageResponseDto.fromEntity(updated);
  }

  /**
   * Rejects a request that carried no usable file part, and returns the file so
   * the caller does not have to narrow the type itself.
   *
   * `!Buffer.isBuffer(file.buffer)` covers more than a missing `file`: it also
   * catches a part multer parsed but could not buffer. Handing that to
   * `CloudinaryService` would fail there with a similar-but-different 400, so the
   * check lives here where the cause is still knowable.
   */
  private assertFileIsPresent(
    file: UploadedImageFile | undefined,
  ): UploadedImageFile {
    if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
      throw new BadRequestException(
        'An image file is required in the "file" field',
      );
    }

    return file;
  }

  /**
   * Deletes an orphaned asset after its database insert failed, then rethrows the
   * original error.
   *
   * Without this, a rejected insert — a unique-violation on the partial primary
   * index, a deadlock, a dropped connection — leaves the file uploaded in the
   * Cloudinary account with no row referencing it. Nothing else would ever find it:
   * `publicId` is the only pointer, and it was never stored. That is a slow storage
   * leak that no future endpoint can clean up, which is why the compensation is
   * part of the operation rather than an optimisation.
   *
   * The compensation failure is logged and swallowed, never propagated. The caller
   * needs the *original* database error — reporting "cleanup failed" instead would
   * hide the real fault and send the caller looking in the wrong place. The
   * compensation `publicId` is logged so the leak is at least traceable if the
   * delete itself fails.
   */
  private async compensateFailedUpload(
    publicId: string,
    originalError: unknown,
  ): Promise<void> {
    try {
      await this.cloudinaryService.deleteAsset(publicId);
    } catch (compensationError) {
      this.logger.error(
        `Failed to remove orphaned Cloudinary asset ${publicId} after a database ` +
          `error; it must be deleted manually (original error: ${this.describe(originalError)}, ` +
          `cleanup error: ${this.describe(compensationError)})`,
      );
    }
  }

  /** Renders an unknown thrown value for a log line, without assuming a shape. */
  private describe(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return typeof error === 'string' ? error : 'unknown error';
  }

  /**
   * Builds the update payload from the fields the client actually sent.
   *
   * An absent key is left out of the object entirely so Prisma never writes an
   * `undefined` column, while an explicit `null` is forwarded and therefore
   * clears `altText`.
   *
   * `isPrimary` is absent from the returned type on purpose. It is handled by the
   * caller through the dedicated transactional paths, so it can never be written
   * as a bare flag change that skips the demotion of the incumbent.
   */
  private buildUpdateData(dto: UpdateProductImageDto): UpdateProductImageData {
    const data: UpdateProductImageData = {};

    if (dto.imageUrl !== undefined) {
      data.imageUrl = dto.imageUrl.trim();
    }

    if (dto.publicId !== undefined) {
      data.publicId = dto.publicId.trim();
    }

    if (dto.altText !== undefined) {
      data.altText = dto.altText === null ? null : dto.altText.trim();
    }

    if (dto.sortOrder !== undefined) {
      data.sortOrder = dto.sortOrder;
    }

    return data;
  }

  /**
   * Rejects a body whose `productId` disagrees with the path.
   *
   * The path is authoritative — it is what the request addresses — but silently
   * ignoring a contradictory body would let a client believe it wrote an image to
   * the product it named while the row landed under a different one.
   */
  private assertBodyMatchesPath(
    productId: string,
    bodyProductId: string,
  ): void {
    if (bodyProductId !== productId) {
      throw new BadRequestException(
        'productId must match the product in the request path',
      );
    }
  }

  private normalizeAltText(altText?: string | null): string | null {
    return altText === undefined || altText === null ? null : altText.trim();
  }

  /** Confirms the product exists, so its images can be addressed at all. */
  private async requireProduct(productId: string): Promise<void> {
    const product = await this.productsRepository.findById(productId);

    if (product === null) {
      throw new NotFoundException(`Product ${productId} does not exist`);
    }
  }

  /**
   * Loads an image only if it belongs to `productId`, otherwise 404.
   *
   * One message covers both "no such image" and "belongs to another product" on
   * purpose; see the ownership note on the class.
   */
  private async requireOwnedImage(
    productId: string,
    imageId: string,
  ): Promise<ProductImage> {
    const image =
      await this.productImagesRepository.findByIdAndProductId(
        imageId,
        productId,
      );

    if (image === null) {
      throw new NotFoundException(`Product image ${imageId} does not exist`);
    }

    return image;
  }

  /**
   * Rejects clearing the flag on an image that is currently the primary one.
   *
   * Because the database allows at most one primary per product, an image with
   * `isPrimary: true` is by definition the *only* primary, so clearing it would
   * always leave the product without one. The rule is therefore unconditional on
   * the current flag rather than dependent on counting other images — which is
   * also why the caller cannot talk its way past it by adding images first: the
   * new primary has to be promoted, and only then is this flag already false.
   */
  private async assertPrimaryCanBeDemoted(image: ProductImage): Promise<void> {
    if (!image.isPrimary) {
      return;
    }

    const productId = image.productId;
    const primary =
      await this.productImagesRepository.findPrimaryByProductId(productId);

    /**
     * Re-read rather than trust the flag above: between the two queries another
     * request may already have promoted a different image, in which case clearing
     * this flag is harmless. The re-read is what makes the 409 accurate instead of
     * rejecting a request that is actually safe.
     */
    if (primary === null || primary.id !== image.id) {
      return;
    }

    throw new ConflictException(CANNOT_CLEAR_PRIMARY_MESSAGE);
  }
}
