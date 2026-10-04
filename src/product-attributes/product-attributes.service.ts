import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { normalizeName } from '../common/utils/normalize-name.js';
import {
  Prisma,
  type ProductAttribute,
} from '../generated/prisma/client.js';
import { ProductsRepository } from '../products/repositories/products.repository.js';
import { CreateProductAttributeDto } from './dto/create-product-attribute.dto.js';
import { ProductAttributeResponseDto } from './dto/product-attribute-response.dto.js';
import { UpdateProductAttributeDto } from './dto/update-product-attribute.dto.js';
import {
  ProductAttributesRepository,
  type CreateProductAttributeData,
  type UpdateProductAttributeData,
} from './repositories/product-attributes.repository.js';

const PRISMA_UNIQUE_CONSTRAINT_VIOLATION = 'P2002';
const PRODUCT_ATTRIBUTE_MODEL = 'ProductAttribute';
const ATTRIBUTE_NAME_FIELD = 'attributeName';
const ATTRIBUTE_NAME_COLUMN = 'attribute_name';
const DUPLICATE_ATTRIBUTE_NAME_MESSAGE =
  'A product attribute with this name already exists';

/**
 * All product-attribute business rules live here; the repository only knows about
 * SQL and the controller only knows about HTTP.
 *
 * ## Cross-aggregate reads
 *
 * Product existence is confirmed through `ProductsRepository` rather than through
 * Prisma, so this feature's repository never reaches into `products` and no SQL is
 * duplicated. Attributes describe the product itself — unlike `VariantOption`
 * there is no variant layer — so the ownership chain is a single hop:
 * ProductAttributes -> Products.
 *
 * ## Ownership
 *
 * `productId` always comes from the URL and `attributeId` from the path. The
 * product must exist and the attribute must belong to it before a request is
 * served, and any mismatch is a 404. The attribute lookup filters by owner in the
 * query, so "no such attribute" and "that attribute belongs to another product"
 * are indistinguishable and neither leaks another product's attribute.
 *
 * ## Error semantics
 *
 * The mapping below is applied consistently and is the only place where a
 * database error becomes an HTTP one. Anything not listed here propagates
 * untouched so that genuine faults are never disguised as client errors.
 *
 * | Condition                                                        | Status | Rationale                                                   |
 * | ---------------------------------------------------------------- | ------ | ----------------------------------------------------------- |
 * | Malformed product or attribute UUID                              | 400    | Rejected by `ParseUUIDPipe`, before the service is reached. |
 * | Invalid payload                                                  | 400    | Rejected by the DTO validators.                            |
 * | Product does not exist                                           | 404    | The addressed resource is absent.                          |
 * | Attribute does not exist or belongs to another product           | 404    | Same 404, so ownership cannot be probed.                   |
 * | Duplicate attribute name (case-insensitive) on the same product  | 409    | The request collides with an existing uniqueness rule.     |
 *
 * A foreign key failure on write (`P2003`) is *not* mapped: by the time an
 * attribute is written its product has already been validated, so a violation
 * means the product was removed concurrently — a genuine fault that must surface
 * as a 500 rather than invite the client to retry blindly.
 */
@Injectable()
export class ProductAttributesService {
  constructor(
    private readonly productAttributesRepository: ProductAttributesRepository,
    private readonly productsRepository: ProductsRepository,
  ) {}

  async create(
    productId: string,
    dto: CreateProductAttributeDto,
  ): Promise<ProductAttributeResponseDto> {
    await this.requireProduct(productId);

    const data: CreateProductAttributeData = {
      productId,
      attributeName: normalizeName(dto.attributeName),
      attributeValue: normalizeName(dto.attributeValue),
    };

    await this.assertAttributeNameAvailable(productId, data.attributeName);

    try {
      const attribute = await this.productAttributesRepository.create(data);

      return ProductAttributeResponseDto.fromEntity(attribute);
    } catch (error) {
      this.rethrowAsHttpError(error);
    }
  }

  async findAllByProductId(
    productId: string,
  ): Promise<ProductAttributeResponseDto[]> {
    await this.requireProduct(productId);

    const attributes =
      await this.productAttributesRepository.findAllByProductId(productId);

    return attributes.map((attribute) =>
      ProductAttributeResponseDto.fromEntity(attribute),
    );
  }

  async findOne(
    productId: string,
    attributeId: string,
  ): Promise<ProductAttributeResponseDto> {
    const attribute = await this.requireOwnedAttribute(productId, attributeId);

    return ProductAttributeResponseDto.fromEntity(attribute);
  }

  async update(
    productId: string,
    attributeId: string,
    dto: UpdateProductAttributeDto,
  ): Promise<ProductAttributeResponseDto> {
    await this.requireOwnedAttribute(productId, attributeId);

    const data = this.buildUpdateData(dto);

    if (dto.attributeName !== undefined) {
      await this.assertAttributeNameAvailable(
        productId,
        normalizeName(dto.attributeName),
        attributeId,
      );
    }

    try {
      const attribute = await this.productAttributesRepository.update(
        attributeId,
        data,
      );

      return ProductAttributeResponseDto.fromEntity(attribute);
    } catch (error) {
      this.rethrowAsHttpError(error);
    }
  }

  async remove(productId: string, attributeId: string): Promise<void> {
    await this.requireOwnedAttribute(productId, attributeId);

    await this.productAttributesRepository.delete(attributeId);
  }

  /**
   * Builds the update payload from the fields the client actually sent.
   *
   * An absent key is left out of the object entirely so Prisma never writes an
   * `undefined` column. `productId` cannot appear here at all: ownership is fixed
   * at creation and is absent from `UpdateProductAttributeDto` and from
   * {@link UpdateProductAttributeData}, so it is unreachable from a public write.
   */
  private buildUpdateData(
    dto: UpdateProductAttributeDto,
  ): UpdateProductAttributeData {
    const data: UpdateProductAttributeData = {};

    if (dto.attributeName !== undefined) {
      data.attributeName = normalizeName(dto.attributeName);
    }

    if (dto.attributeValue !== undefined) {
      data.attributeValue = normalizeName(dto.attributeValue);
    }

    return data;
  }

  /** Confirms the product exists, so its attributes can be addressed at all. */
  private async requireProduct(productId: string): Promise<void> {
    const product = await this.productsRepository.findById(productId);

    if (product === null) {
      throw new NotFoundException(`Product ${productId} does not exist`);
    }
  }

  /**
   * Loads an attribute only if it belongs to `productId`, otherwise 404.
   *
   * The product is re-resolved here rather than trusted from an earlier call so
   * this helper is safe to use on its own from every method, and one message
   * covers "no such attribute" and "belongs to another product".
   */
  private async requireOwnedAttribute(
    productId: string,
    attributeId: string,
  ): Promise<ProductAttribute> {
    await this.requireProduct(productId);

    const attribute =
      await this.productAttributesRepository.findByIdAndProductId(
        attributeId,
        productId,
      );

    if (attribute === null) {
      throw new NotFoundException(
        `Product attribute ${attributeId} does not exist`,
      );
    }

    return attribute;
  }

  /**
   * Rejects a duplicate attribute name with 409.
   *
   * The comparison is case-insensitive, so `Material` and `material` collide. This
   * is a pre-flight check so the client gets a deterministic message instead of a
   * constraint violation. It cannot fully replace the `P2002` mapping in
   * {@link rethrowAsHttpError}: two concurrent requests can both pass this check,
   * and only the database — through the functional unique index on
   * `lower(attribute_name)` — can settle the race.
   *
   * `excludeId` lets an update keep its own name (including a case-only change)
   * without colliding with itself.
   */
  private async assertAttributeNameAvailable(
    productId: string,
    attributeName: string,
    excludeId?: string,
  ): Promise<void> {
    const existing =
      await this.productAttributesRepository.findByProductIdAndAttributeName(
        productId,
        attributeName,
      );

    if (existing !== null && existing.id !== excludeId) {
      throw new ConflictException(DUPLICATE_ATTRIBUTE_NAME_MESSAGE);
    }
  }

  /**
   * Translates the one Prisma error this feature can legitimately produce on a
   * write into HTTP semantics, and rethrows everything else unchanged.
   *
   * Only `P2002` on the attribute name is mapped. Any other known request error —
   * a connection failure, a deadlock, a foreign key violation, a missing table —
   * is a genuine fault and is allowed to surface as a 500 rather than being
   * laundered into a 4xx.
   */
  private rethrowAsHttpError(error: unknown): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === PRISMA_UNIQUE_CONSTRAINT_VIOLATION &&
      this.isAttributeNameUniqueViolation(error)
    ) {
      throw new ConflictException(DUPLICATE_ATTRIBUTE_NAME_MESSAGE);
    }

    throw error;
  }

  /**
   * Detects a unique constraint violation on the attribute name.
   *
   * Prisma only populates `meta.target` for engines that report it. With driver
   * adapters such as `@prisma/adapter-pg` the meta object carries only
   * `modelName` and `driverAdapterError`, so the model name is used as the
   * fallback. The primary key is a server-generated UUID, so a `P2002` on
   * `product_attributes` is a duplicate attribute name in practice.
   */
  private isAttributeNameUniqueViolation(
    error: Prisma.PrismaClientKnownRequestError,
  ): boolean {
    const meta = error.meta;
    const target = meta?.['target'];

    if (Array.isArray(target)) {
      return (
        target.includes(ATTRIBUTE_NAME_FIELD) ||
        target.includes(ATTRIBUTE_NAME_COLUMN)
      );
    }

    if (typeof target === 'string') {
      return (
        target === ATTRIBUTE_NAME_FIELD || target === ATTRIBUTE_NAME_COLUMN
      );
    }

    return meta?.['modelName'] === PRODUCT_ATTRIBUTE_MODEL;
  }
}
