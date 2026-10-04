import { Injectable } from '@nestjs/common';
import type { ProductAttribute } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * The exact columns `ProductAttributesRepository.create` is allowed to write.
 *
 * `id`, `createdAt` and `updatedAt` are absent because they are database-owned
 * and must never be reachable from a request payload.
 *
 * `productId` is present because an attribute cannot exist without an owner; the
 * service always fills it from the URL rather than from the body.
 */
export interface CreateProductAttributeData {
  productId: string;
  attributeName: string;
  attributeValue: string;
}

/**
 * The subset of columns a `PATCH` may write. Absent keys are left untouched.
 *
 * `productId` is missing on purpose: ownership is fixed at creation, so no public
 * write can move an attribute to another product.
 */
export interface UpdateProductAttributeData {
  attributeName?: string;
  attributeValue?: string;
}

/**
 * The only place in the product-attributes feature that talks to the database.
 *
 * It owns ProductAttribute persistence and nothing else: no normalisation, no
 * ownership reasoning, no duplicate-name reasoning, no exception mapping, no DTO
 * mapping, no HTTP status decisions. That keeps the SQL surface of the
 * ProductAttribute aggregate in one auditable file and lets the service express
 * *what* it needs without knowing the query shape.
 *
 * Product rows are reached through `ProductsRepository`, never from here, so this
 * file never joins or filters across aggregates.
 */
@Injectable()
export class ProductAttributesRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Persists a new attribute and returns the stored entity. */
  create(data: CreateProductAttributeData): Promise<ProductAttribute> {
    return this.prisma.productAttribute.create({ data });
  }

  /**
   * Returns every attribute belonging to `productId`, insertion order.
   *
   * `createdAt` ascending reflects the order a merchant recorded the facts in,
   * and `id` breaks ties so two attributes created in the same transaction still
   * come back in a stable order between identical requests. Without it the
   * listing, and any pagination added later, would be non-deterministic.
   */
  findAllByProductId(productId: string): Promise<ProductAttribute[]> {
    return this.prisma.productAttribute.findMany({
      where: { productId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  /**
   * Returns the attribute `id` only when it belongs to `productId`, else `null`.
   *
   * Filtering by owner in the query — rather than fetching by id and comparing in
   * the service — means a caller cannot distinguish "no such attribute" from
   * "that attribute belongs to another product", which is what lets both answer
   * 404 without leaking the existence of another product's attribute.
   */
  findByIdAndProductId(
    id: string,
    productId: string,
  ): Promise<ProductAttribute | null> {
    return this.prisma.productAttribute.findFirst({
      where: { id, productId },
    });
  }

  /**
   * Returns the attribute on `productId` whose name matches `attributeName`
   * under case-insensitive comparison, or `null` when there is none.
   *
   * `mode: 'insensitive'` is used rather than a compound unique lookup because the
   * unique constraint that makes this true is a functional index on
   * `lower(attribute_name)`, which Prisma cannot address from a generated `where`.
   * The query mirrors what that index enforces.
   */
  findByProductIdAndAttributeName(
    productId: string,
    attributeName: string,
  ): Promise<ProductAttribute | null> {
    return this.prisma.productAttribute.findFirst({
      where: {
        productId,
        attributeName: { equals: attributeName, mode: 'insensitive' },
      },
    });
  }

  /**
   * Writes only the columns present in `data`, so an update can never
   * accidentally overwrite an unrelated column with an undefined value.
   *
   * Rejects with Prisma's `P2025` when `id` does not exist; the service resolves
   * ownership first so that maps to a 404.
   */
  update(
    id: string,
    data: UpdateProductAttributeData,
  ): Promise<ProductAttribute> {
    return this.prisma.productAttribute.update({ where: { id }, data });
  }

  /** Removes the attribute owning `id` and returns the row as it was. */
  delete(id: string): Promise<ProductAttribute> {
    return this.prisma.productAttribute.delete({ where: { id } });
  }
}
