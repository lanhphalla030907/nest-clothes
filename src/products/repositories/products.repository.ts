import { Injectable } from '@nestjs/common';
import type { Product } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * The exact columns `ProductsRepository.create` is allowed to write.
 *
 * `id`, `createdAt` and `updatedAt` are missing because they are database-owned
 * and must never be reachable from a request payload.
 *
 * `status` and `isActive` appear here but deliberately **not** in
 * {@link UpdateProductData}: a product is born with a lifecycle state, and no
 * public write path may change one. Restating the rule in the type means the
 * compiler rejects the attempt rather than relying on a runtime check.
 */
export interface CreateProductData {
  categoryId: string;
  name: string;
  slug: string;
  description: string | null;
  basePrice: string;
  status: string;
  isActive: boolean;
}

/** The subset of columns a `PATCH` may write. Absent keys are left untouched. */
export interface UpdateProductData {
  categoryId?: string;
  name?: string;
  slug?: string;
  description?: string | null;
  basePrice?: string;
}

/**
 * The only place in the products feature that talks to the database.
 *
 * It owns Product persistence and nothing else: no normalisation, no lifecycle
 * rules, no category validation, no exception mapping, no DTO mapping. That
 * keeps the SQL surface of the Product aggregate in one auditable file and lets
 * the service express *what* it needs without knowing the query shape.
 *
 * Category rows are reached through `CategoriesRepository`, never from here, so
 * this file never joins or filters across aggregates.
 *
 * The methods below are the complete set required by the application today.
 * It is deliberately not generalised into a base class or generic CRUD helper —
 * each method states exactly which columns and filters it touches.
 */
@Injectable()
export class ProductsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Persists a new product and returns the stored entity. */
  create(data: CreateProductData): Promise<Product> {
    return this.prisma.product.create({ data });
  }

  /**
   * Returns every product, newest first.
   *
   * `id` breaks ties because two products can share a `created_at` value down to
   * the microsecond; without it the order — and therefore pagination added later
   * — would be unstable between identical requests.
   *
   * Inactive and non-`ACTIVE` products are included because listing is an
   * administrative read, not the storefront browse.
   */
  findAll(): Promise<Product[]> {
    return this.prisma.product.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
  }

  /** Returns the product owning `id`, or `null` when no such product exists. */
  findById(id: string): Promise<Product | null> {
    return this.prisma.product.findUnique({ where: { id } });
  }

  /** Returns the product owning `slug`, or `null` when no such product exists. */
  findBySlug(slug: string): Promise<Product | null> {
    return this.prisma.product.findUnique({ where: { slug } });
  }

  /**
   * Writes only the columns present in `data`, so an update can never
   * accidentally overwrite an unrelated column with an undefined value.
   *
   * Rejects with Prisma's `P2025` when `id` does not exist; the service resolves
   * existence first so that maps to a 404.
   */
  update(id: string, data: UpdateProductData): Promise<Product> {
    return this.prisma.product.update({ where: { id }, data });
  }

  /**
   * Removes the product owning `id`.
   *
   * A hard delete is acceptable *only* because nothing references a product yet.
   * Once images, variants, cart lines and order lines exist this must become a
   * soft delete or a guarded hard delete — see `ProductsService.remove`.
   */
  delete(id: string): Promise<Product> {
    return this.prisma.product.delete({ where: { id } });
  }
}