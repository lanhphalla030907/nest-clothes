import { Injectable } from '@nestjs/common';
import { Prisma, type Product } from '../../generated/prisma/client.js';
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
 * The lifecycle columns, and nothing else.
 *
 * A **separate type** from {@link UpdateProductData} on purpose: that type is what the
 * public `PATCH /products` path writes, so adding `status`/`isActive` to it would make
 * the catalogue lifecycle reachable from an unauthenticated request. Keeping the two
 * apart means {@link ProductsRepository.update} cannot write them even by accident, and
 * only {@link ProductsRepository.updateLifecycle} can.
 */
export interface UpdateProductLifecycleData {
  status?: string;
  isActive?: boolean;
}

/**
 * Optional narrowing for a catalogue listing.
 *
 * Every field is an `AND` term and an absent field is not a filter at all, so
 * `findMany({})` is exactly the unfiltered listing. The set is deliberately the four
 * questions a catalogue manager actually asks — "what is in this category", "what is
 * still a draft", "what did we switch off", "what is this called" — and no more.
 */
export interface ProductFilters {
  /** Exact lifecycle value. */
  status?: string;
  /** The record-level enable flag, independent of `status`. */
  isActive?: boolean;
  /** The owning category. */
  categoryId?: string;
  /** Case-insensitive substring of the name **or** the slug. */
  search?: string;
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
    return this.findMany();
  }

  /**
   * Returns the products matching `filters`, newest first.
   *
   * `id` breaks ties because two products can share a `created_at` value down to
   * the microsecond; without it the order — and therefore pagination added later
   * — would be unstable between identical requests.
   *
   * Inactive and non-`ACTIVE` products are included because listing is an
   * administrative read, not the storefront browse.
   *
   * `search` is a case-insensitive substring across `name` and `slug`, and is the
   * reason `ilike` is used instead of Prisma's `contains`: a merchant who remembers
   * "peacoat" should not have to remember which case the row was stored in.
   */
  findMany(filters: ProductFilters = {}): Promise<Product[]> {
    const where: Prisma.ProductWhereInput = {
      ...(filters.status === undefined ? {} : { status: filters.status }),
      ...(filters.isActive === undefined ? {} : { isActive: filters.isActive }),
      ...(filters.categoryId === undefined
        ? {}
        : { categoryId: filters.categoryId }),
      ...(filters.search === undefined
        ? {}
        : {
            OR: [
              { name: { contains: filters.search, mode: 'insensitive' } },
              { slug: { contains: filters.search, mode: 'insensitive' } },
            ],
          }),
    };

    return this.prisma.product.findMany({
      where,
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
   * Writes only the lifecycle columns, and only the ones present in `data`.
   *
   * A second write method rather than two optional keys on {@link update}, so the
   * separation the {@link UpdateProductLifecycleData} type draws is also a separation
   * in the SQL surface: the public write path has no method that can reach
   * `products.status` or `products.is_active`.
   */
  updateLifecycle(
    id: string,
    data: UpdateProductLifecycleData,
  ): Promise<Product> {
    return this.prisma.product.update({ where: { id }, data });
  }

  /**
   * Removes the product owning `id`.
   *
   * A hard delete cascades to the product's own components — images, variants,
   * attributes and their options and stock — but PostgreSQL refuses it with a foreign
   * key violation (`P2003`) while the product is still referenced from *outside* that
   * cascade: a `wishlist_items` row points at the product and `cart_items` and
   * `order_items` point at its variants, all `ON DELETE RESTRICT`. The service turns
   * that refusal into a 409 rather than letting it surface as a 500.
   */
  delete(id: string): Promise<Product> {
    return this.prisma.product.delete({ where: { id } });
  }
}