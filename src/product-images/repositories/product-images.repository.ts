import { Injectable } from '@nestjs/common';
import type { ProductImage } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * The exact columns `ProductImagesRepository.create` is allowed to write.
 *
 * `id`, `createdAt` and `updatedAt` are absent because they are database-owned
 * and must never be reachable from a request payload.
 */
export interface CreateProductImageData {
  productId: string;
  imageUrl: string;
  publicId: string;
  altText: string | null;
  sortOrder: number;
  isPrimary: boolean;
}

/**
 * The subset of columns a `PATCH` may write. Absent keys are left untouched.
 *
 * `productId` is missing on purpose: ownership is fixed at creation, so no
 * public write can move an image to another product.
 */
export interface UpdateProductImageData {
  imageUrl?: string;
  publicId?: string;
  altText?: string | null;
  sortOrder?: number;
  isPrimary?: boolean;
}

/**
 * The only place in the product-images feature that talks to the database.
 *
 * It owns ProductImage persistence and nothing else: no normalisation, no
 * primary-image reasoning, no exception mapping, no DTO mapping, no URL
 * validation, no HTTP status decisions. That keeps the SQL surface of the
 * ProductImage aggregate in one auditable file and lets the service express
 * *what* it needs without knowing the query shape.
 *
 * Product rows are reached through `ProductsRepository`, never from here, so
 * this file never joins or filters across aggregates.
 *
 * The transaction helpers below are the one deliberate concession to
 * persistence-only concerns: a primary-image change is two writes that must
 * either both land or neither do, and only this layer knows how to express that
 * as a single `BEGIN`/`COMMIT`.
 */
@Injectable()
export class ProductImagesRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Persists a new image and returns the stored entity. */
  create(data: CreateProductImageData): Promise<ProductImage> {
    return this.prisma.productImage.create({ data });
  }

  /**
   * Returns every image belonging to `productId`, in display order.
   *
   * `sortOrder` ascending is the contract the caller asked for, and `createdAt`
   * ascending breaks ties so two images sharing a position still come back in a
   * stable order between identical requests. Without it the listing — and any
   * pagination added later — would be non-deterministic.
   */
  findAllByProductId(productId: string): Promise<ProductImage[]> {
    return this.prisma.productImage.findMany({
      where: { productId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /** Returns the image owning `id`, or `null` when no such image exists. */
  findById(id: string): Promise<ProductImage | null> {
    return this.prisma.productImage.findUnique({ where: { id } });
  }

  /**
   * Returns the product's primary image, or `null` when it has none.
   *
   * Uses `findFirst` with an explicit filter rather than a compound unique
   * lookup because the constraint that makes "at most one" true is a partial
   * index, and Prisma cannot address it from a generated `where`.
   */
  findPrimaryByProductId(productId: string): Promise<ProductImage | null> {
    return this.prisma.productImage.findFirst({
      where: { productId, isPrimary: true },
    });
  }

  /**
   * Returns the image `imageId` only when it belongs to `productId`, else `null`.
   *
   * Filtering by owner in the query — rather than fetching by id and comparing in
   * the service — means a caller cannot distinguish "no such image" from "that
   * image belongs to someone else", which is what lets both answer 404 without
   * leaking the existence of another product's asset.
   */
  findByIdAndProductId(
    imageId: string,
    productId: string,
  ): Promise<ProductImage | null> {
    return this.prisma.productImage.findFirst({
      where: { id: imageId, productId },
    });
  }

  /**
   * Writes only the columns present in `data`, so an update can never
   * accidentally overwrite an unrelated column with an undefined value.
   *
   * Rejects with Prisma's `P2025` when `id` does not exist; the service resolves
   * ownership first so that maps to a 404.
   */
  update(id: string, data: UpdateProductImageData): Promise<ProductImage> {
    return this.prisma.productImage.update({ where: { id }, data });
  }

  /** Removes the image owning `id` and returns the row as it was. */
  delete(id: string): Promise<ProductImage> {
    return this.prisma.productImage.delete({ where: { id } });
  }

  /**
   * Atomically demotes every current primary image of `productId`, then promotes
   * `imageId`.
   *
   * Both statements run in one interactive transaction so the product is never
   * momentarily without a primary, and never momentarily with two. Returning the
   * promoted row keeps the caller from issuing a second read.
   *
   * The `id: { not: imageId }` guard makes promoting an already-primary image a
   * no-op instead of a self-demotion, so the caller can invoke this
   * unconditionally.
   *
   * Ordering matters: the demotion is issued first so the partial unique index
   * is never momentarily violated. A concurrent request doing the same swap can
   * still win the race, and in that case PostgreSQL rejects *its* insert — the
   * index, not this transaction, is the arbiter.
   */
  async promoteToPrimary(
    productId: string,
    imageId: string,
  ): Promise<ProductImage> {
    const [, promoted] = await this.prisma.$transaction([
      this.prisma.productImage.updateMany({
        where: { productId, isPrimary: true, id: { not: imageId } },
        data: { isPrimary: false },
      }),
      this.prisma.productImage.update({
        where: { id: imageId },
        data: { isPrimary: true },
      }),
    ]);

    return promoted;
  }

  /**
   * Creates an image as the product's primary in one transaction.
   *
   * Same reasoning as {@link promoteToPrimary}: demote the incumbent first, then
   * insert, so the partial unique index is satisfied at every point the
   * transaction is visible.
   */
  async createAsPrimary(
    data: CreateProductImageData,
  ): Promise<ProductImage> {
    const [, created] = await this.prisma.$transaction([
      this.prisma.productImage.updateMany({
        where: { productId: data.productId, isPrimary: true },
        data: { isPrimary: false },
      }),
      this.prisma.productImage.create({
        data: { ...data, isPrimary: true },
      }),
    ]);

    return created;
  }

  /**
   * Applies an ordinary column update *and* promotes the row in one transaction.
   *
   * Without this, `PATCH { altText, isPrimary: true }` would need a demote and a
   * combined promote-write; splitting them across two round trips would let a
   * concurrent request observe the intermediate state. The single `update` in the
   * array carries both the caller's columns and `isPrimary: true`, so the row is
   * written exactly once.
   */
  async updateAsPrimary(
    imageId: string,
    productId: string,
    data: UpdateProductImageData,
  ): Promise<ProductImage> {
    const [, promoted] = await this.prisma.$transaction([
      this.prisma.productImage.updateMany({
        where: { productId, isPrimary: true, id: { not: imageId } },
        data: { isPrimary: false },
      }),
      this.prisma.productImage.update({
        where: { id: imageId },
        data: { ...data, isPrimary: true },
      }),
    ]);

    return promoted;
  }
}
