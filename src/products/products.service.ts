import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CategoriesRepository } from '../categories/repositories/categories.repository.js';
import { normalizeMoney } from '../common/utils/normalize-money.js';
import { normalizeName } from '../common/utils/normalize-name.js';
import { normalizeSlug } from '../common/utils/normalize-slug.js';
import {
  Prisma,
  type Product,
} from '../generated/prisma/client.js';
import {
  DEFAULT_PRODUCT_IS_ACTIVE,
  DEFAULT_PRODUCT_STATUS,
  type ProductStatus,
} from './constants/product-status.constants.js';
import { CreateProductDto } from './dto/create-product.dto.js';
import { ProductResponseDto } from './dto/product-response.dto.js';
import { UpdateProductDto } from './dto/update-product.dto.js';
import {
  ProductsRepository,
  type CreateProductData,
  type ProductFilters,
  type UpdateProductData,
  type UpdateProductLifecycleData,
} from './repositories/products.repository.js';

const PRISMA_UNIQUE_CONSTRAINT_VIOLATION = 'P2002';
const PRISMA_FOREIGN_KEY_CONSTRAINT_VIOLATION = 'P2003';
const PRODUCT_MODEL = 'Product';
const SLUG_FIELD = 'slug';
const DUPLICATE_SLUG_MESSAGE = 'A product with this slug already exists';
const PRODUCT_IS_REFERENCED_MESSAGE =
  'Product cannot be deleted while it is referenced by a wishlist, a cart or an order; deactivate it instead';

/**
 * The lifecycle a caller may set, as distinct from the catalogue content.
 *
 * Both fields are optional and neither is inferred from the other: `status` says where
 * the product is in its lifecycle and `isActive` says whether the record is enabled.
 * An `ADMIN` can hold an `ACTIVE` product switched off, and can park a `DRAFT` that is
 * enabled, because the two answers are separate questions and collapsing them here would
 * redefine what the columns already mean everywhere else.
 *
 * No transition table accompanies it. None exists in this codebase to honour, and
 * inventing one would reject requests the current application considers valid — so a
 * status is validated as a member of the lifecycle and otherwise applied as written.
 */
export interface ProductLifecycleInput {
  status?: ProductStatus;
  isActive?: boolean;
}

/**
 * All product business rules live here; the repositories only know about SQL
 * and the controller only knows about HTTP.
 *
 * ## Cross-aggregate reads
 *
 * Category validation goes through `CategoriesRepository` rather than through
 * Prisma, so neither repository reaches into the other's table and no SQL for
 * `categories` is duplicated. The cost is that the "a product may only be filed
 * under an active category" rule is restated here rather than reused from
 * `CategoriesService`. That is deliberate: the rule is evaluated from the
 * product side, against a repository boundary that exposes no service method for
 * it, and the two implementations are asserted to agree by their own tests.
 *
 * ## Error semantics
 *
 * The mapping below is applied consistently and is the only place where a
 * database error becomes an HTTP one. Anything not listed here propagates
 * untouched so that genuine faults are never disguised as client errors.
 *
 * | Condition                                | Status | Rationale                                                       |
 * | ---------------------------------------- | ------ | --------------------------------------------------------------- |
 * | Malformed product UUID                   | 400    | Rejected by `ParseUUIDPipe`, before the service is reached.      |
 * | Invalid payload                          | 400    | Rejected by the DTO validators.                                  |
 * | Product does not exist                   | 404    | The addressed resource is absent.                               |
 * | `categoryId` does not exist              | 404    | `categoryId` references another resource, so it gets the same 404. |
 * | Duplicate `slug`                         | 409    | The request collides with an existing uniqueness constraint.     |
 * | `categoryId` refers to an inactive category | 409 | Valid target, but it conflicts with the current state.           |
 * | Delete while a cart/wishlist/order holds it | 409  | Valid target, but rows elsewhere still point at it.             |
 *
 * A foreign key failure on write (`P2003`) is *not* mapped, apart from on delete: by the
 * time a product is written its category has already been validated, so a violation
 * means the row was removed concurrently — a genuine fault that must surface as a 500
 * rather than invite the client to retry blindly.
 */
@Injectable()
export class ProductsService {
  constructor(
    private readonly productsRepository: ProductsRepository,
    private readonly categoriesRepository: CategoriesRepository,
  ) {}

  async create(
    dto: CreateProductDto,
    lifecycle?: ProductLifecycleInput,
  ): Promise<ProductResponseDto> {
    const data: CreateProductData = {
      categoryId: dto.categoryId,
      name: normalizeName(dto.name),
      slug: normalizeSlug(dto.slug),
      description: this.normalizeDescription(dto.description),
      basePrice: normalizeMoney(dto.basePrice),
      /**
       * An absent lifecycle leaves the constants in charge, so a create through the
       * public route and a create that names a lifecycle behave identically when the
       * caller says nothing. `isActive` defaults to `true` but `status` to `DRAFT`, so
       * a product created without a lifecycle is *enabled* yet *unpublished*: enabling a
       * record is not the same decision as putting it on sale, and the admin surface
       * states both explicitly rather than inferring one from the other.
       */
      status: lifecycle?.status ?? DEFAULT_PRODUCT_STATUS,
      isActive: lifecycle?.isActive ?? DEFAULT_PRODUCT_IS_ACTIVE,
    };

    await this.assertSlugAvailable(data.slug);
    await this.assertCategoryAssignable(data.categoryId);

    try {
      const product = await this.productsRepository.create(data);

      return ProductResponseDto.fromEntity(product);
    } catch (error) {
      this.rethrowAsHttpError(error);
    }
  }

  async findAll(): Promise<ProductResponseDto[]> {
    const products = await this.productsRepository.findAll();

    return products.map((product) => ProductResponseDto.fromEntity(product));
  }

  /**
   * The filtered listing, for a catalogue manager rather than a storefront.
   *
   * Same rows, same order, same mapping as {@link findAll} — only the `where` clause
   * differs — so there is one definition of what a product *is* in this application.
   * The filters are the ones the query layer can already express; inventing a query
   * language here would add a second place for catalogue semantics to live.
   */
  async findMany(filters: ProductFilters = {}): Promise<ProductResponseDto[]> {
    const products = await this.productsRepository.findMany(filters);

    return products.map((product) => ProductResponseDto.fromEntity(product));
  }

  async findOne(id: string): Promise<ProductResponseDto> {
    const product = await this.requireProduct(id);

    return ProductResponseDto.fromEntity(product);
  }

  /**
   * Updates catalogue content, and optionally the lifecycle.
   *
   * `lifecycle` is a separate argument rather than extra DTO fields, because the two
   * halves have different authority: content is what any caller with write access may
   * change, while `status` and `isActive` are reachable only from a route whose every
   * handler is behind `RolesGuard`. A public `PATCH` cannot supply the argument at all,
   * because `UpdateProductDto` has no such property and the global pipe runs
   * `forbidNonWhitelisted` — so a request that tries is refused with 400 rather than
   * quietly having its `status` dropped.
   *
   * An absent key writes nothing. That is the property that keeps an unrelated edit —
   * a price correction, a typo in the name — from changing whether the product is on
   * sale, which is the failure this argument's shape exists to prevent.
   */
  async update(
    id: string,
    dto: UpdateProductDto,
    lifecycle?: ProductLifecycleInput,
  ): Promise<ProductResponseDto> {
    const current = await this.requireProduct(id);

    const data = this.buildUpdateData(dto);
    const lifecycleData = this.buildLifecycleData(lifecycle);

    if (dto.slug !== undefined) {
      await this.assertSlugAvailable(normalizeSlug(dto.slug), id);
    }

    if (dto.categoryId !== undefined) {
      await this.assertCategoryAssignable(dto.categoryId);
    }

    try {
      /**
       * Two writes, in this order, and only when both are non-empty: content first so
       * that a rejected slug or category never leaves a lifecycle change behind. They
       * are two statements rather than one transaction because they are two different
       * repository methods by design, and an admin that changes a price and promotes a
       * product is not a case worth a transaction boundary.
       */
      /**
       * The content write's own result is carried forward rather than discarded, so a
       * price-only PATCH answers with the price that was just written instead of the
       * value read before the write.
       */
      const contentUpdated =
        Object.keys(data).length > 0
          ? await this.productsRepository.update(id, data)
          : null;

      /**
       * With neither half present the row loaded above is already the answer, and
       * writing it back would only bump `updatedAt` and re-lock the row.
       */
      const product =
        Object.keys(lifecycleData).length > 0
          ? await this.productsRepository.updateLifecycle(id, lifecycleData)
          : (contentUpdated ?? current);

      return ProductResponseDto.fromEntity(product);
    } catch (error) {
      this.rethrowAsHttpError(error);
    }
  }

  /**
   * Hard-deletes a product.
   *
   * Components the product owns cascade away with it — images, variants, their options
   * and their inventory, attributes — because they are meaningless without it. What is
   * *not* cascaded is a reference from outside the aggregate: `wishlist_items` points at
   * the product, and `cart_items` and `order_items` point at its variants, all
   * `ON DELETE RESTRICT`. PostgreSQL refuses those deletes with `P2003`, which becomes a
   * 409 rather than a 500: the request was legitimate and the product is simply not
   * free to go yet. Deactivating it (`isActive: false`) is the alternative that does not
   * disturb anybody's basket.
   */
  async remove(id: string): Promise<void> {
    await this.requireProduct(id);

    try {
      await this.productsRepository.delete(id);
    } catch (error) {
      this.rethrowDeleteError(error);
    }
  }

  /**
   * Builds the update payload from the fields the client actually sent.
   *
   * An absent key is left out of the object entirely so Prisma never writes an
   * `undefined` column, while an explicit `null` is forwarded and therefore
   * clears `description`.
   *
   * `status` and `isActive` cannot appear here at all: they are absent from
   * {@link UpdateProductData} and from `UpdateProductDto`, so the lifecycle is
   * unreachable from a public write.
   */
  private buildUpdateData(dto: UpdateProductDto): UpdateProductData {
    const data: UpdateProductData = {};

    if (dto.name !== undefined) {
      data.name = normalizeName(dto.name);
    }

    if (dto.slug !== undefined) {
      data.slug = normalizeSlug(dto.slug);
    }

    if (dto.description !== undefined) {
      data.description = this.normalizeDescription(dto.description);
    }

    if (dto.basePrice !== undefined) {
      data.basePrice = normalizeMoney(dto.basePrice);
    }

    if (dto.categoryId !== undefined) {
      data.categoryId = dto.categoryId;
    }

    return data;
  }

  private normalizeDescription(description?: string | null): string | null {
    return description === undefined || description === null
      ? null
      : description.trim();
  }

  /**
   * Builds the lifecycle payload from the fields the caller actually named.
   *
   * The type is `Partial` and the object is built key by key for one reason: a
   * `PATCH` that changes only the name must produce `{}` here, so the service writes
   * neither `status` nor `is_active` and the product's sellability is untouched. An
   * implementation that always returned `{ status: dto.status, isActive: dto.isActive }`
   * would silently unpublish every product whose price was corrected.
   */
  private buildLifecycleData(
    lifecycle?: ProductLifecycleInput,
  ): UpdateProductLifecycleData {
    const data: UpdateProductLifecycleData = {};

    if (lifecycle === undefined) {
      return data;
    }

    if (lifecycle.status !== undefined) {
      data.status = lifecycle.status;
    }

    if (lifecycle.isActive !== undefined) {
      data.isActive = lifecycle.isActive;
    }

    return data;
  }

  /** Loads a product or rejects the request with 404. */
  private async requireProduct(id: string): Promise<Product> {
    const product = await this.productsRepository.findById(id);

    if (product === null) {
      throw new NotFoundException(`Product ${id} does not exist`);
    }

    return product;
  }

  /**
   * Rejects a duplicate slug with 409.
   *
   * This is a pre-flight check so the client gets a deterministic message
   * instead of a constraint violation. It cannot fully replace the `P2002`
   * mapping in {@link rethrowAsHttpError}: two concurrent requests can both pass
   * this check, and only the database can settle the race.
   *
   * `excludeId` lets an update keep its own slug without colliding with itself.
   */
  private async assertSlugAvailable(slug: string, excludeId?: string): Promise<void> {
    const existing = await this.productsRepository.findBySlug(slug);

    if (existing !== null && existing.id !== excludeId) {
      throw new ConflictException(DUPLICATE_SLUG_MESSAGE);
    }
  }

  /**
   * Validates the category a product is filed under.
   *
   * The category must exist (404) and must be active (409): filing a product
   * under a deactivated category would publish an item inside a section the
   * storefront has already hidden.
   */
  private async assertCategoryAssignable(categoryId: string): Promise<void> {
    const category = await this.categoriesRepository.findById(categoryId);

    if (category === null) {
      throw new NotFoundException(`Category ${categoryId} does not exist`);
    }

    if (!category.isActive) {
      throw new ConflictException(`Category ${category.slug} is not active`);
    }
  }

  /**
   * Translates the one Prisma error this feature can legitimately produce on a
   * write into HTTP semantics, and rethrows everything else unchanged.
   *
   * Only `P2002` on the slug is mapped. Any other known request error — a
   * connection failure, a deadlock, a foreign key violation, a missing table —
   * is a genuine fault and is allowed to surface as a 500 rather than being
   * laundered into a 4xx.
   */
  private rethrowAsHttpError(error: unknown): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === PRISMA_UNIQUE_CONSTRAINT_VIOLATION &&
      this.isSlugUniqueViolation(error)
    ) {
      throw new ConflictException(DUPLICATE_SLUG_MESSAGE);
    }

    throw error;
  }

  /**
   * Delete-specific mapping, on top of {@link rethrowAsHttpError}.
   *
   * `P2003` means the product is still referenced from outside its own cascade — a
   * wishlist, a cart or an order — which is a conflict with stored rows rather than a
   * fault. It is translated *only* here: on a create or an update the same code would
   * mean the category was deleted concurrently, and reporting that as "referenced by a
   * cart" would send the caller chasing the wrong problem.
   */
  private rethrowDeleteError(error: unknown): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === PRISMA_FOREIGN_KEY_CONSTRAINT_VIOLATION
    ) {
      throw new ConflictException(PRODUCT_IS_REFERENCED_MESSAGE);
    }

    this.rethrowAsHttpError(error);
  }

  /**
   * Detects a unique constraint violation on `products.slug`.
   *
   * Prisma only populates `meta.target` for engines that report it. With driver
   * adapters such as `@prisma/adapter-pg` the meta object carries only
   * `modelName` and `driverAdapterError`, so the model name is used as the
   * fallback. `slug` is currently the only unique constraint on `products`; if
   * another one is added this check must be narrowed accordingly.
   */
  private isSlugUniqueViolation(error: Prisma.PrismaClientKnownRequestError): boolean {
    const meta = error.meta;
    const target = meta?.['target'];

    if (Array.isArray(target)) {
      return target.includes(SLUG_FIELD);
    }

    if (typeof target === 'string') {
      return target === SLUG_FIELD;
    }

    return meta?.['modelName'] === PRODUCT_MODEL;
  }
}