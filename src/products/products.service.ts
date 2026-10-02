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
} from './constants/product-status.constants.js';
import { CreateProductDto } from './dto/create-product.dto.js';
import { ProductResponseDto } from './dto/product-response.dto.js';
import { UpdateProductDto } from './dto/update-product.dto.js';
import {
  ProductsRepository,
  type CreateProductData,
  type UpdateProductData,
} from './repositories/products.repository.js';

const PRISMA_UNIQUE_CONSTRAINT_VIOLATION = 'P2002';
const PRODUCT_MODEL = 'Product';
const SLUG_FIELD = 'slug';
const DUPLICATE_SLUG_MESSAGE = 'A product with this slug already exists';

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
 *
 * A foreign key failure on write (`P2003`) is *not* mapped: by the time a
 * product is written its category has already been validated, so a violation
 * means the row was removed concurrently — a genuine fault that must surface as
 * a 500 rather than invite the client to retry blindly.
 */
@Injectable()
export class ProductsService {
  constructor(
    private readonly productsRepository: ProductsRepository,
    private readonly categoriesRepository: CategoriesRepository,
  ) {}

  async create(dto: CreateProductDto): Promise<ProductResponseDto> {
    const data: CreateProductData = {
      categoryId: dto.categoryId,
      name: normalizeName(dto.name),
      slug: normalizeSlug(dto.slug),
      description: this.normalizeDescription(dto.description),
      basePrice: normalizeMoney(dto.basePrice),
      status: DEFAULT_PRODUCT_STATUS,
      isActive: DEFAULT_PRODUCT_IS_ACTIVE,
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

  async findOne(id: string): Promise<ProductResponseDto> {
    const product = await this.requireProduct(id);

    return ProductResponseDto.fromEntity(product);
  }

  async update(id: string, dto: UpdateProductDto): Promise<ProductResponseDto> {
    await this.requireProduct(id);

    const data = this.buildUpdateData(dto);

    if (dto.slug !== undefined) {
      await this.assertSlugAvailable(normalizeSlug(dto.slug), id);
    }

    if (dto.categoryId !== undefined) {
      await this.assertCategoryAssignable(dto.categoryId);
    }

    try {
      const product = await this.productsRepository.update(id, data);

      return ProductResponseDto.fromEntity(product);
    } catch (error) {
      this.rethrowAsHttpError(error);
    }
  }

  /**
   * Hard-deletes a product.
   *
   * Acceptable for now only because nothing references a product yet. As soon as
   * images, variants, cart lines or order lines point at `products.id`, this
   * method must become a soft delete or a guarded hard delete — at that point
   * PostgreSQL will start answering with `P2003`, which this method currently
   * lets propagate on purpose rather than guessing a 409 message for a
   * condition that cannot happen yet.
   */
  async remove(id: string): Promise<void> {
    await this.requireProduct(id);

    try {
      await this.productsRepository.delete(id);
    } catch (error) {
      this.rethrowAsHttpError(error);
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