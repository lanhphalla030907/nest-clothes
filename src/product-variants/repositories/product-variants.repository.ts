import { Injectable } from '@nestjs/common';
import type { ProductVariant } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * The exact columns `ProductVariantsRepository.create` is allowed to write.
 *
 * `id`, `createdAt` and `updatedAt` are absent because they are database-owned
 * and must never be reachable from a request payload.
 *
 * `productId` is present because a variant cannot exist without an owner; the
 * service always fills it from the URL rather than from the body.
 */
export interface CreateProductVariantData {
  productId: string;
  sku: string;
  price: string;
  isActive: boolean;
}

/**
 * The subset of columns a `PATCH` may write. Absent keys are left untouched.
 *
 * `productId` is missing on purpose: ownership is fixed at creation, so no
 * public write can move a variant to another product.
 */
export interface UpdateProductVariantData {
  sku?: string;
  price?: string;
  isActive?: boolean;
}

/**
 * The only place in the product-variants feature that talks to the database.
 *
 * It owns ProductVariant persistence and nothing else: no normalisation, no
 * ownership reasoning, no duplicate-SKU reasoning, no exception mapping, no DTO
 * mapping, no HTTP status decisions. That keeps the SQL surface of the
 * ProductVariant aggregate in one auditable file and lets the service express
 * *what* it needs without knowing the query shape.
 *
 * Product rows are reached through `ProductsRepository`, never from here, so this
 * file never joins or filters across aggregates.
 */
@Injectable()
export class ProductVariantsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Persists a new variant and returns the stored entity. */
  create(data: CreateProductVariantData): Promise<ProductVariant> {
    return this.prisma.productVariant.create({ data });
  }

  /**
   * Returns every variant belonging to `productId`, oldest first.
   *
   * `createdAt` ascending reflects insertion order — the order a merchant
   * configured the options in — and `id` breaks ties so two variants created in
   * the same transaction still come back in a stable order between identical
   * requests. Without it the listing, and any pagination added later, would be
   * non-deterministic.
   */
  findAllByProductId(productId: string): Promise<ProductVariant[]> {
    return this.prisma.productVariant.findMany({
      where: { productId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  /**
   * Returns the variant `id` only when it belongs to `productId`, else `null`.
   *
   * Filtering by owner in the query — rather than fetching by id and comparing in
   * the service — means a caller cannot distinguish "no such variant" from "that
   * variant belongs to another product", which is what lets both answer 404
   * without leaking the existence of another product's variant.
   */
  findByIdAndProductId(
    id: string,
    productId: string,
  ): Promise<ProductVariant | null> {
    return this.prisma.productVariant.findFirst({
      where: { id, productId },
    });
  }

  /**
   * Returns the variant carrying `sku`, or `null` when none does.
   *
   * The lookup is global, not scoped to a product, because `sku` is unique
   * across the whole catalogue.
   */
  findBySku(sku: string): Promise<ProductVariant | null> {
    return this.prisma.productVariant.findUnique({ where: { sku } });
  }

  /**
   * Returns the variant with `id`, or `null` when none does.
   *
   * The lookup is deliberately unscoped by product: the caller is not walking the
   * catalogue tree but addressing one variant directly (a cart line, for
   * instance), so there is no parent product in the request to scope against.
   */
  findById(id: string): Promise<ProductVariant | null> {
    return this.prisma.productVariant.findUnique({ where: { id } });
  }

  /**
   * Writes only the columns present in `data`, so an update can never
   * accidentally overwrite an unrelated column with an undefined value.
   *
   * Rejects with Prisma's `P2025` when `id` does not exist; the service resolves
   * ownership first so that maps to a 404.
   */
  update(id: string, data: UpdateProductVariantData): Promise<ProductVariant> {
    return this.prisma.productVariant.update({ where: { id }, data });
  }

  /** Removes the variant owning `id` and returns the row as it was. */
  delete(id: string): Promise<ProductVariant> {
    return this.prisma.productVariant.delete({ where: { id } });
  }
}
