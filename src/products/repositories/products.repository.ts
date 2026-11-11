import { Injectable } from '@nestjs/common';
import { Prisma, type Product } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PublicProductQueryDto } from '../dto/public-product-query.dto.js';
import { ProductFilterOptionsDto } from '../dto/public-product-list-response.dto.js';

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
  async findNewArrivals(limit = 8): Promise<Product[]> {
    return this.prisma.product.findMany({
      where: {
        status: 'ACTIVE',
        isActive: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: limit,
    });
  }

  async findBestSellers(limit = 8): Promise<Product[]> {
    const rows = await this.prisma.$queryRaw<Array<{ productId: string; unitsSold: bigint | number }>>`
      WITH eligible_orders AS (
        SELECT o."id" FROM "orders" o
        WHERE o."status" <> 'CANCELLED'
          AND (
            (o."payment_method" <> 'COD' AND EXISTS (SELECT 1 FROM "payments" p WHERE p."order_id" = o."id" AND p."status" = 'PAID'))
            OR
            (o."payment_method" = 'COD'
              AND EXISTS (SELECT 1 FROM "cod_collections" cc WHERE cc."order_id" = o."id")
              AND EXISTS (SELECT 1 FROM "delivery_assignments" da WHERE da."order_id" = o."id" AND da."status" = 'DELIVERED' AND da."ended_at" IS NOT NULL)
              AND NOT EXISTS (SELECT 1 FROM "delivery_assignments" da2 WHERE da2."order_id" = o."id" AND da2."status" IN ('PENDING_ASSIGNMENT','ASSIGNED','OUT_FOR_DELIVERY','FAILED_DELIVERY')))
          )
      )
      SELECT pv."product_id" AS "productId", SUM(oi."quantity") AS "unitsSold"
      FROM "order_items" oi
      JOIN eligible_orders eo ON eo."id" = oi."order_id"
      JOIN "product_variants" pv ON pv."id" = oi."variant_id"
      GROUP BY pv."product_id"
      ORDER BY SUM(oi."quantity") DESC, pv."product_id" ASC
      LIMIT ${limit}
    `;
    const ids = rows.map((r) => r.productId);
    if (ids.length === 0) return [];
    const products = await this.prisma.product.findMany({ where: { id: { in: ids }, status: 'ACTIVE', isActive: true } });
    const map = new Map(products.map((p) => [p.id, p]));
    return rows.map((r) => map.get(r.productId)).filter(Boolean) as Product[];
  }

  delete(id: string): Promise<Product> {
    return this.prisma.product.delete({ where: { id } });
  }

  async findPublicProducts(query: PublicProductQueryDto = {}): Promise<{
    products: Product[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
    filterOptions: ProductFilterOptionsDto;
  }> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? Math.min(query.limit, 100) : 12;
    const offset = (page - 1) * limit;

    const conditions: Prisma.Sql[] = [
      Prisma.sql`p."status" = 'ACTIVE'`,
      Prisma.sql`p."is_active" = true`,
      Prisma.sql`c."is_active" = true`,
    ];

    if (query.category) {
      conditions.push(
        Prisma.sql`(c."slug" = ${query.category} OR c."id"::text = ${query.category})`,
      );
    }

    if (query.search) {
      const pattern = `%${query.search}%`;
      conditions.push(
        Prisma.sql`(p."name" ILIKE ${pattern} OR COALESCE(p."description", '') ILIKE ${pattern} OR p."slug" ILIKE ${pattern})`,
      );
    }

    if (query.minPrice !== undefined) {
      conditions.push(Prisma.sql`pep.effective_price >= ${query.minPrice}`);
    }

    if (query.maxPrice !== undefined) {
      conditions.push(Prisma.sql`pep.effective_price <= ${query.maxPrice}`);
    }

    const hasVariantFilter = Boolean(query.size || query.color || query.inStock !== undefined);

    if (hasVariantFilter) {
      if (!query.size && !query.color && query.inStock === false) {
        conditions.push(
          Prisma.sql`NOT EXISTS (
            SELECT 1 FROM "product_variants" pv
            JOIN "inventory" inv ON inv."variant_id" = pv."id"
            WHERE pv."product_id" = p."id"
              AND pv."is_active" = true
              AND (inv."quantity" - inv."reserved_quantity") > 0
          )`,
        );
      } else {
        const variantSubConditions: Prisma.Sql[] = [
          Prisma.sql`pv."product_id" = p."id"`,
          Prisma.sql`pv."is_active" = true`,
        ];

        if (query.size) {
          variantSubConditions.push(
            Prisma.sql`EXISTS (
              SELECT 1 FROM "variant_options" vo
              WHERE vo."variant_id" = pv."id"
                AND LOWER(vo."option_name") = 'size'
                AND LOWER(vo."option_value") = LOWER(${query.size})
            )`,
          );
        }

        if (query.color) {
          variantSubConditions.push(
            Prisma.sql`EXISTS (
              SELECT 1 FROM "variant_options" vo
              WHERE vo."variant_id" = pv."id"
                AND LOWER(vo."option_name") IN ('color', 'colour')
                AND LOWER(vo."option_value") = LOWER(${query.color})
            )`,
          );
        }

        if (query.inStock !== undefined) {
          if (query.inStock === true) {
            variantSubConditions.push(
              Prisma.sql`EXISTS (
                SELECT 1 FROM "inventory" inv
                WHERE inv."variant_id" = pv."id"
                  AND (inv."quantity" - inv."reserved_quantity") > 0
              )`,
            );
          } else {
            variantSubConditions.push(
              Prisma.sql`(
                NOT EXISTS (SELECT 1 FROM "inventory" inv WHERE inv."variant_id" = pv."id")
                OR EXISTS (
                  SELECT 1 FROM "inventory" inv
                  WHERE inv."variant_id" = pv."id"
                    AND (inv."quantity" - inv."reserved_quantity") <= 0
                )
              )`,
            );
          }
        }

        conditions.push(
          Prisma.sql`EXISTS (
            SELECT 1 FROM "product_variants" pv
            WHERE ${Prisma.join(variantSubConditions, ' AND ')}
          )`,
        );
      }
    }

    let orderByClause: Prisma.Sql;
    switch (query.sortBy) {
      case 'price_asc':
        orderByClause = Prisma.sql`pep.effective_price ASC, p."id" ASC`;
        break;
      case 'price_desc':
        orderByClause = Prisma.sql`pep.effective_price DESC, p."id" ASC`;
        break;
      case 'best_selling':
        orderByClause = Prisma.sql`COALESCE(sales.units_sold, 0) DESC, p."created_at" DESC, p."id" ASC`;
        break;
      case 'newest':
      default:
        orderByClause = Prisma.sql`p."created_at" DESC, p."id" ASC`;
        break;
    }

    const whereSql = Prisma.join(conditions, ' AND ');

    const countRows = await this.prisma.$queryRaw<Array<{ count: number | bigint }>>`
      WITH product_effective_prices AS (
        SELECT
          p."id" AS product_id,
          COALESCE(
            (
              SELECT MIN(pv."price")
              FROM "product_variants" pv
              JOIN "inventory" inv ON inv."variant_id" = pv."id"
              WHERE pv."product_id" = p."id"
                AND pv."is_active" = true
                AND (inv."quantity" - inv."reserved_quantity") > 0
            ),
            p."base_price"
          ) AS effective_price
        FROM "products" p
        WHERE p."status" = 'ACTIVE' AND p."is_active" = true
      )
      SELECT COUNT(DISTINCT p."id")::int AS count
      FROM "products" p
      JOIN "categories" c ON c."id" = p."category_id"
      JOIN product_effective_prices pep ON pep.product_id = p."id"
      WHERE ${whereSql}
    `;

    const total = Number(countRows[0]?.count ?? 0);
    const totalPages = limit > 0 ? Math.ceil(total / limit) : 0;

    const filterOptionsPromise = this.getFilterOptions();

    if (total === 0) {
      const filterOptions = await filterOptionsPromise;
      return {
        products: [],
        total: 0,
        page,
        limit,
        totalPages: 0,
        filterOptions,
      };
    }

    const idRows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      WITH product_effective_prices AS (
        SELECT
          p."id" AS product_id,
          COALESCE(
            (
              SELECT MIN(pv."price")
              FROM "product_variants" pv
              JOIN "inventory" inv ON inv."variant_id" = pv."id"
              WHERE pv."product_id" = p."id"
                AND pv."is_active" = true
                AND (inv."quantity" - inv."reserved_quantity") > 0
            ),
            p."base_price"
          ) AS effective_price
        FROM "products" p
        WHERE p."status" = 'ACTIVE' AND p."is_active" = true
      ),
      sales AS (
        SELECT pv."product_id", SUM(oi."quantity")::int AS units_sold
        FROM "order_items" oi
        JOIN "orders" o ON o."id" = oi."order_id"
        JOIN "product_variants" pv ON pv."id" = oi."variant_id"
        WHERE o."status" = 'DELIVERED'
        GROUP BY pv."product_id"
      )
      SELECT p."id"
      FROM "products" p
      JOIN "categories" c ON c."id" = p."category_id"
      JOIN product_effective_prices pep ON pep.product_id = p."id"
      LEFT JOIN sales ON sales.product_id = p."id"
      WHERE ${whereSql}
      ORDER BY ${orderByClause}
      LIMIT ${limit} OFFSET ${offset}
    `;

    const ids = idRows.map((r) => r.id);
    const products = await this.prisma.product.findMany({
      where: { id: { in: ids } },
    });
    const productMap = new Map(products.map((p) => [p.id, p]));
    const sortedProducts = ids.map((id) => productMap.get(id)).filter((p): p is Product => Boolean(p));

    const filterOptions = await filterOptionsPromise;

    return {
      products: sortedProducts,
      total,
      page,
      limit,
      totalPages,
      filterOptions,
    };
  }

  async getFilterOptions(): Promise<ProductFilterOptionsDto> {
    const [categories, priceRange, sizes, colors] = await Promise.all([
      this.prisma.$queryRaw<Array<{ id: string; name: string; slug: string; count: number | bigint }>>`
        SELECT c."id", c."name", c."slug", COUNT(p."id")::int AS count
        FROM "categories" c
        JOIN "products" p ON p."category_id" = c."id"
        WHERE c."is_active" = true
          AND p."status" = 'ACTIVE'
          AND p."is_active" = true
        GROUP BY c."id", c."name", c."slug"
        HAVING COUNT(p."id") > 0
        ORDER BY c."name" ASC
      `,
      this.prisma.$queryRaw<Array<{ min_price: number | null; max_price: number | null }>>`
        WITH product_effective_prices AS (
          SELECT
            p."id",
            COALESCE(
              (
                SELECT MIN(pv."price")
                FROM "product_variants" pv
                JOIN "inventory" inv ON inv."variant_id" = pv."id"
                WHERE pv."product_id" = p."id"
                  AND pv."is_active" = true
                  AND (inv."quantity" - inv."reserved_quantity") > 0
              ),
              p."base_price"
            ) AS effective_price
          FROM "products" p
          JOIN "categories" c ON c."id" = p."category_id" AND c."is_active" = true
          WHERE p."status" = 'ACTIVE' AND p."is_active" = true
        )
        SELECT
          COALESCE(MIN(effective_price), 0)::float AS min_price,
          COALESCE(MAX(effective_price), 0)::float AS max_price
        FROM product_effective_prices
      `,
      this.prisma.$queryRaw<Array<{ size: string }>>`
        SELECT DISTINCT vo."option_value" AS size
        FROM "variant_options" vo
        JOIN "product_variants" pv ON pv."id" = vo."variant_id"
        JOIN "products" p ON p."id" = pv."product_id"
        JOIN "categories" c ON c."id" = p."category_id" AND c."is_active" = true
        WHERE LOWER(vo."option_name") = 'size'
          AND pv."is_active" = true
          AND p."status" = 'ACTIVE'
          AND p."is_active" = true
        ORDER BY vo."option_value" ASC
      `,
      this.prisma.$queryRaw<Array<{ color: string }>>`
        SELECT DISTINCT vo."option_value" AS color
        FROM "variant_options" vo
        JOIN "product_variants" pv ON pv."id" = vo."variant_id"
        JOIN "products" p ON p."id" = pv."product_id"
        JOIN "categories" c ON c."id" = p."category_id" AND c."is_active" = true
        WHERE LOWER(vo."option_name") IN ('color', 'colour')
          AND pv."is_active" = true
          AND p."status" = 'ACTIVE'
          AND p."is_active" = true
        ORDER BY vo."option_value" ASC
      `,
    ]);

    return {
      categories: categories.map((c) => ({
        id: c.id,
        name: c.name,
        slug: c.slug,
        count: Number(c.count),
      })),
      priceRange: {
        min: Number(priceRange[0]?.min_price ?? 0),
        max: Number(priceRange[0]?.max_price ?? 0),
      },
      sizes: sizes.map((s) => s.size).filter(Boolean),
      colors: colors.map((c) => c.color).filter(Boolean),
    };
  }
}

