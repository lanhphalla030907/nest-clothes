import { Injectable } from '@nestjs/common';
import { Prisma, type ProductVariant } from '../../generated/prisma/client.js';
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
  combinationKey: string;
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

export interface UpdateVariantCostData {
  costPrice: string;
  costCurrency: string;
  changedById: string;
}

export interface BulkUpdateVariantCostData {
  productId: string;
  changedById: string;
  variants: Array<{
    variantId: string;
    costPrice: string;
    costCurrency: string;
  }>;
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

  createDefaultIfUnconfigured(
    data: CreateProductVariantData,
  ): Promise<ProductVariant | null> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id"
        FROM "products"
        WHERE "id" = ${data.productId}::uuid
        FOR UPDATE
      `;
      if (locked.length === 0) return null;

      const [variantCount, activeOptionCount] = await Promise.all([
        tx.productVariant.count({ where: { productId: data.productId } }),
        tx.productOption.count({
          where: { productId: data.productId, isActive: true },
        }),
      ]);
      if (variantCount > 0 || activeOptionCount > 0) return null;

      const variant = await tx.productVariant.create({ data });
      await tx.product.update({
        where: { id: data.productId },
        data: { optionsRevision: { increment: 1 } },
      });
      return variant;
    });
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

  findByIdsAndProductId(
    ids: string[],
    productId: string,
  ): Promise<ProductVariant[]> {
    if (ids.length === 0) return Promise.resolve([]);

    return this.prisma.productVariant.findMany({
      where: { id: { in: ids }, productId },
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

  hasVariantsForProduct(productId: string): Promise<boolean> {
    return this.prisma.productVariant
      .count({ where: { productId } })
      .then((count) => count > 0);
  }

  hasActiveOptionsForProduct(productId: string): Promise<boolean> {
    return this.prisma.productOption
      .count({ where: { productId, isActive: true } })
      .then((count) => count > 0);
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

  updateForProduct(
    productId: string,
    variantId: string,
    data: UpdateProductVariantData,
  ): Promise<ProductVariant | null> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id"
        FROM "products"
        WHERE "id" = ${productId}::uuid
        FOR UPDATE
      `;
      if (locked.length === 0) return null;

      const ownedVariant = await tx.productVariant.findFirst({
        where: { id: variantId, productId },
        select: { id: true },
      });
      if (ownedVariant === null) return null;

      const variant = await tx.productVariant.update({
        where: { id: variantId },
        data,
      });
      await tx.product.update({
        where: { id: productId },
        data: { optionsRevision: { increment: 1 } },
      });
      return variant;
    });
  }

  /**
   * Changes the live internal cost and its immutable audit ledger in one
   * transaction. Closing the old current row before inserting the replacement
   * works with the partial unique index that permits one current row per variant.
   */
  updateCostForProduct(
    productId: string,
    variantId: string,
    data: UpdateVariantCostData,
  ): Promise<ProductVariant | null> {
    return this.prisma.$transaction(async (tx) => {
      const variant = await tx.productVariant.findFirst({
        where: { id: variantId, productId },
      });
      if (variant === null) return null;

      const nextCost = new Prisma.Decimal(data.costPrice);
      const unchanged =
        variant.costPrice !== null &&
        variant.costPrice.equals(nextCost) &&
        variant.costCurrency === data.costCurrency;
      if (unchanged) return variant;

      const effectiveAt = new Date();
      await tx.variantCostHistory.updateMany({
        where: { variantId, effectiveTo: null },
        data: { effectiveTo: effectiveAt },
      });
      await tx.variantCostHistory.create({
        data: {
          variantId,
          cost: nextCost,
          currency: data.costCurrency,
          effectiveFrom: effectiveAt,
          createdById: data.changedById,
        },
      });
      return tx.productVariant.update({
        where: { id: variantId },
        data: {
          costPrice: nextCost,
          costCurrency: data.costCurrency,
          costEffectiveAt: effectiveAt,
        },
      });
    });
  }

  /**
   * Applies one purchase cost to many variants of the same product in a single
   * transaction. Each variant's cost history ledger is updated independently,
   * so historical `OrderItem.unitCostSnapshot` rows are never touched and each
   * variant keeps its own audit trail. Variants whose cost is unchanged are
   * skipped without writing a new history row.
   */
  updateVariantCostsForProduct(
    data: BulkUpdateVariantCostData,
  ): Promise<ProductVariant[]> {
    return this.prisma.$transaction(async (tx) => {
      const variantIds = data.variants.map((entry) => entry.variantId);
      const variants = await tx.productVariant.findMany({
        where: { id: { in: variantIds }, productId: data.productId },
      });

      const byId = new Map(variants.map((variant) => [variant.id, variant]));
      const effectiveAt = new Date();
      const results: ProductVariant[] = [];

      for (const entry of data.variants) {
        const variant = byId.get(entry.variantId);
        if (variant === undefined) continue;

        const nextCost = new Prisma.Decimal(entry.costPrice);
        const unchanged =
          variant.costPrice !== null &&
          variant.costPrice.equals(nextCost) &&
          variant.costCurrency === entry.costCurrency;
        if (unchanged) {
          results.push(variant);
          continue;
        }

        await tx.variantCostHistory.updateMany({
          where: { variantId: entry.variantId, effectiveTo: null },
          data: { effectiveTo: effectiveAt },
        });
        await tx.variantCostHistory.create({
          data: {
            variantId: entry.variantId,
            cost: nextCost,
            currency: entry.costCurrency,
            effectiveFrom: effectiveAt,
            createdById: data.changedById,
          },
        });
        const updated = await tx.productVariant.update({
          where: { id: entry.variantId },
          data: {
            costPrice: nextCost,
            costCurrency: entry.costCurrency,
            costEffectiveAt: effectiveAt,
          },
        });
        results.push(updated);
      }

      return results;
    });
  }

  /** Removes the variant owning `id` and returns the row as it was. */
  delete(id: string): Promise<ProductVariant> {
    return this.prisma.productVariant.delete({ where: { id } });
  }
}
