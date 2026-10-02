import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { normalizeMoney } from '../common/utils/normalize-money.js';
import { normalizeSku } from '../common/utils/normalize-sku.js';
import {
  Prisma,
  type ProductVariant,
} from '../generated/prisma/client.js';
import { ProductsRepository } from '../products/repositories/products.repository.js';
import { CreateProductVariantDto } from './dto/create-product-variant.dto.js';
import { ProductVariantResponseDto } from './dto/product-variant-response.dto.js';
import { UpdateProductVariantDto } from './dto/update-product-variant.dto.js';
import {
  ProductVariantsRepository,
  type CreateProductVariantData,
  type UpdateProductVariantData,
} from './repositories/product-variants.repository.js';

const PRISMA_UNIQUE_CONSTRAINT_VIOLATION = 'P2002';
const PRODUCT_VARIANT_MODEL = 'ProductVariant';
const SKU_FIELD = 'sku';
const DUPLICATE_SKU_MESSAGE = 'A variant with this SKU already exists';
const DEFAULT_VARIANT_IS_ACTIVE = true;

/**
 * All product-variant business rules live here; the repositories only know about
 * SQL and the controller only knows about HTTP.
 *
 * ## Cross-aggregate reads
 *
 * Product existence is confirmed through `ProductsRepository` rather than through
 * Prisma, so neither repository reaches into the other's table and no SQL for
 * `products` is duplicated. The edge runs one way — variants depend on products,
 * never the reverse — so the module graph stays acyclic.
 *
 * ## Ownership
 *
 * `productId` always comes from the URL. A variant is only ever loaded through
 * `findByIdAndProductId`, so "no such variant" and "that variant belongs to
 * another product" are indistinguishable and both answer 404 without leaking the
 * existence of another product's variant.
 *
 * ## Error semantics
 *
 * The mapping below is applied consistently and is the only place where a
 * database error becomes an HTTP one. Anything not listed here propagates
 * untouched so that genuine faults are never disguised as client errors.
 *
 * | Condition                                        | Status | Rationale                                                       |
 * | ------------------------------------------------ | ------ | --------------------------------------------------------------- |
 * | Malformed product or variant UUID                | 400    | Rejected by `ParseUUIDPipe`, before the service is reached.      |
 * | Invalid payload                                  | 400    | Rejected by the DTO validators.                                  |
 * | Product does not exist                           | 404    | The addressed resource is absent.                               |
 * | Variant does not exist or belongs to another product | 404 | Same 404, so ownership cannot be probed.                        |
 * | Duplicate `sku`                                  | 409    | The request collides with an existing uniqueness constraint.     |
 *
 * A foreign key failure on write (`P2003`) is *not* mapped: by the time a variant
 * is written its product has already been validated, so a violation means the row
 * was removed concurrently — a genuine fault that must surface as a 500 rather
 * than invite the client to retry blindly.
 */
@Injectable()
export class ProductVariantsService {
  constructor(
    private readonly productVariantsRepository: ProductVariantsRepository,
    private readonly productsRepository: ProductsRepository,
  ) {}

  async create(
    productId: string,
    dto: CreateProductVariantDto,
  ): Promise<ProductVariantResponseDto> {
    await this.requireProduct(productId);

    const data: CreateProductVariantData = {
      productId,
      sku: normalizeSku(dto.sku),
      price: normalizeMoney(dto.price),
      isActive: dto.isActive ?? DEFAULT_VARIANT_IS_ACTIVE,
    };

    await this.assertSkuAvailable(data.sku);

    try {
      const variant = await this.productVariantsRepository.create(data);

      return ProductVariantResponseDto.fromEntity(variant);
    } catch (error) {
      this.rethrowAsHttpError(error);
    }
  }

  async findAllByProductId(
    productId: string,
  ): Promise<ProductVariantResponseDto[]> {
    await this.requireProduct(productId);

    const variants =
      await this.productVariantsRepository.findAllByProductId(productId);

    return variants.map((variant) =>
      ProductVariantResponseDto.fromEntity(variant),
    );
  }

  async findOne(
    productId: string,
    variantId: string,
  ): Promise<ProductVariantResponseDto> {
    const variant = await this.requireOwnedVariant(productId, variantId);

    return ProductVariantResponseDto.fromEntity(variant);
  }

  async update(
    productId: string,
    variantId: string,
    dto: UpdateProductVariantDto,
  ): Promise<ProductVariantResponseDto> {
    await this.requireOwnedVariant(productId, variantId);

    const data = this.buildUpdateData(dto);

    if (dto.sku !== undefined) {
      await this.assertSkuAvailable(normalizeSku(dto.sku), variantId);
    }

    try {
      const variant = await this.productVariantsRepository.update(
        variantId,
        data,
      );

      return ProductVariantResponseDto.fromEntity(variant);
    } catch (error) {
      this.rethrowAsHttpError(error);
    }
  }

  async remove(productId: string, variantId: string): Promise<void> {
    await this.requireOwnedVariant(productId, variantId);

    await this.productVariantsRepository.delete(variantId);
  }

  /**
   * Builds the update payload from the fields the client actually sent.
   *
   * An absent key is left out of the object entirely so Prisma never writes an
   * `undefined` column. `productId` cannot appear here at all: it is absent from
   * `UpdateProductVariantDto` and from {@link UpdateProductVariantData}, so
   * ownership is unreachable from a public write.
   */
  private buildUpdateData(
    dto: UpdateProductVariantDto,
  ): UpdateProductVariantData {
    const data: UpdateProductVariantData = {};

    if (dto.sku !== undefined) {
      data.sku = normalizeSku(dto.sku);
    }

    if (dto.price !== undefined) {
      data.price = normalizeMoney(dto.price);
    }

    if (dto.isActive !== undefined) {
      data.isActive = dto.isActive;
    }

    return data;
  }

  /** Confirms the product exists, so its variants can be addressed at all. */
  private async requireProduct(productId: string): Promise<void> {
    const product = await this.productsRepository.findById(productId);

    if (product === null) {
      throw new NotFoundException(`Product ${productId} does not exist`);
    }
  }

  /**
   * Loads a variant only if it belongs to `productId`, otherwise 404.
   *
   * One message covers both "no such variant" and "belongs to another product"
   * on purpose; see the ownership note on the class.
   */
  private async requireOwnedVariant(
    productId: string,
    variantId: string,
  ): Promise<ProductVariant> {
    const variant =
      await this.productVariantsRepository.findByIdAndProductId(
        variantId,
        productId,
      );

    if (variant === null) {
      throw new NotFoundException(
        `Product variant ${variantId} does not exist`,
      );
    }

    return variant;
  }

  /**
   * Rejects a duplicate SKU with 409.
   *
   * This is a pre-flight check so the client gets a deterministic message instead
   * of a constraint violation. It cannot fully replace the `P2002` mapping in
   * {@link rethrowAsHttpError}: two concurrent requests can both pass this check,
   * and only the database can settle the race.
   *
   * The check is global because `sku` is unique across the whole catalogue, not
   * per product. `excludeId` lets an update keep its own SKU without colliding
   * with itself.
   */
  private async assertSkuAvailable(
    sku: string,
    excludeId?: string,
  ): Promise<void> {
    const existing = await this.productVariantsRepository.findBySku(sku);

    if (existing !== null && existing.id !== excludeId) {
      throw new ConflictException(DUPLICATE_SKU_MESSAGE);
    }
  }

  /**
   * Translates the one Prisma error this feature can legitimately produce on a
   * write into HTTP semantics, and rethrows everything else unchanged.
   *
   * Only `P2002` on the SKU is mapped. Any other known request error — a
   * connection failure, a deadlock, a foreign key violation, a missing table — is
   * a genuine fault and is allowed to surface as a 500 rather than being laundered
   * into a 4xx.
   */
  private rethrowAsHttpError(error: unknown): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === PRISMA_UNIQUE_CONSTRAINT_VIOLATION &&
      this.isSkuUniqueViolation(error)
    ) {
      throw new ConflictException(DUPLICATE_SKU_MESSAGE);
    }

    throw error;
  }

  /**
   * Detects a unique constraint violation on `product_variants.sku`.
   *
   * Prisma only populates `meta.target` for engines that report it. With driver
   * adapters such as `@prisma/adapter-pg` the meta object carries only
   * `modelName` and `driverAdapterError`, so the model name is used as the
   * fallback. `sku` is the only client-reachable unique constraint on
   * `product_variants` — the primary key is a server-generated UUID — so a `P2002`
   * on this model is a SKU collision in practice.
   */
  private isSkuUniqueViolation(
    error: Prisma.PrismaClientKnownRequestError,
  ): boolean {
    const meta = error.meta;
    const target = meta?.['target'];

    if (Array.isArray(target)) {
      return target.includes(SKU_FIELD);
    }

    if (typeof target === 'string') {
      return target === SKU_FIELD;
    }

    return meta?.['modelName'] === PRODUCT_VARIANT_MODEL;
  }
}
