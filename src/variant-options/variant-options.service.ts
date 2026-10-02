import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { normalizeName } from '../common/utils/normalize-name.js';
import {
  Prisma,
  type VariantOption,
} from '../generated/prisma/client.js';
import { ProductVariantsRepository } from '../product-variants/repositories/product-variants.repository.js';
import { ProductsRepository } from '../products/repositories/products.repository.js';
import { CreateVariantOptionDto } from './dto/create-variant-option.dto.js';
import { UpdateVariantOptionDto } from './dto/update-variant-option.dto.js';
import { VariantOptionResponseDto } from './dto/variant-option-response.dto.js';
import {
  VariantOptionsRepository,
  type CreateVariantOptionData,
  type UpdateVariantOptionData,
} from './repositories/variant-options.repository.js';

const PRISMA_UNIQUE_CONSTRAINT_VIOLATION = 'P2002';
const VARIANT_OPTION_MODEL = 'VariantOption';
const OPTION_NAME_FIELD = 'optionName';
const OPTION_NAME_COLUMN = 'option_name';
const DUPLICATE_OPTION_NAME_MESSAGE =
  'A variant option with this name already exists';

/**
 * All variant-option business rules live here; the repositories only know about
 * SQL and the controller only knows about HTTP.
 *
 * ## Cross-aggregate reads
 *
 * Product existence is confirmed through `ProductsRepository`, and variant
 * ownership through `ProductVariantsRepository`, rather than through Prisma, so
 * this feature's repository never reaches into `products` or `product_variants`
 * and no SQL is duplicated. The edges run VariantOptions -> ProductVariants ->
 * Products, so the module graph stays acyclic.
 *
 * ## Ownership
 *
 * `productId` and `variantId` always come from the URL. A request must satisfy
 * the whole chain — the product must exist, the variant must belong to that
 * product, and the option must belong to that variant — before it is served. Any
 * mismatch is a 404, and the option lookup filters by owner in the query, so
 * "no such option" and "that option belongs to another variant" are
 * indistinguishable and neither leaks another aggregate's existence.
 *
 * ## Error semantics
 *
 * The mapping below is applied consistently and is the only place where a
 * database error becomes an HTTP one. Anything not listed here propagates
 * untouched so that genuine faults are never disguised as client errors.
 *
 * | Condition                                                    | Status | Rationale                                                       |
 * | ------------------------------------------------------------ | ------ | --------------------------------------------------------------- |
 * | Malformed product, variant or option UUID                    | 400    | Rejected by `ParseUUIDPipe`, before the service is reached.      |
 * | Invalid payload                                              | 400    | Rejected by the DTO validators.                                  |
 * | Product does not exist                                       | 404    | The addressed resource is absent.                               |
 * | Variant does not exist or belongs to another product         | 404    | Same 404, so ownership cannot be probed.                        |
 * | Option does not exist or belongs to another variant          | 404    | Same 404, so ownership cannot be probed.                        |
 * | Duplicate option name (case-insensitive) on the same variant | 409    | The request collides with an existing uniqueness constraint.     |
 *
 * A foreign key failure on write (`P2003`) is *not* mapped: by the time an option
 * is written its variant has already been validated, so a violation means the row
 * was removed concurrently — a genuine fault that must surface as a 500 rather
 * than invite the client to retry blindly.
 */
@Injectable()
export class VariantOptionsService {
  constructor(
    private readonly variantOptionsRepository: VariantOptionsRepository,
    private readonly productVariantsRepository: ProductVariantsRepository,
    private readonly productsRepository: ProductsRepository,
  ) {}

  async create(
    productId: string,
    variantId: string,
    dto: CreateVariantOptionDto,
  ): Promise<VariantOptionResponseDto> {
    await this.requireProduct(productId);
    await this.requireOwnedVariant(productId, variantId);

    const data: CreateVariantOptionData = {
      variantId,
      optionName: normalizeName(dto.optionName),
      optionValue: normalizeName(dto.optionValue),
    };

    await this.assertOptionNameAvailable(variantId, data.optionName);

    try {
      const option = await this.variantOptionsRepository.create(data);

      return VariantOptionResponseDto.fromEntity(option);
    } catch (error) {
      this.rethrowAsHttpError(error);
    }
  }

  async findAllByVariantId(
    productId: string,
    variantId: string,
  ): Promise<VariantOptionResponseDto[]> {
    await this.requireProduct(productId);
    await this.requireOwnedVariant(productId, variantId);

    const options =
      await this.variantOptionsRepository.findAllByVariantId(variantId);

    return options.map((option) => VariantOptionResponseDto.fromEntity(option));
  }

  async findOne(
    productId: string,
    variantId: string,
    optionId: string,
  ): Promise<VariantOptionResponseDto> {
    const option = await this.requireOwnedOption(
      productId,
      variantId,
      optionId,
    );

    return VariantOptionResponseDto.fromEntity(option);
  }

  async update(
    productId: string,
    variantId: string,
    optionId: string,
    dto: UpdateVariantOptionDto,
  ): Promise<VariantOptionResponseDto> {
    await this.requireOwnedOption(productId, variantId, optionId);

    const data = this.buildUpdateData(dto);

    if (dto.optionName !== undefined) {
      await this.assertOptionNameAvailable(
        variantId,
        normalizeName(dto.optionName),
        optionId,
      );
    }

    try {
      const option = await this.variantOptionsRepository.update(optionId, data);

      return VariantOptionResponseDto.fromEntity(option);
    } catch (error) {
      this.rethrowAsHttpError(error);
    }
  }

  async remove(
    productId: string,
    variantId: string,
    optionId: string,
  ): Promise<void> {
    await this.requireOwnedOption(productId, variantId, optionId);

    await this.variantOptionsRepository.delete(optionId);
  }

  /**
   * Builds the update payload from the fields the client actually sent.
   *
   * An absent key is left out of the object entirely so Prisma never writes an
   * `undefined` column. `variantId` cannot appear here at all: it is absent from
   * `UpdateVariantOptionDto` and from {@link UpdateVariantOptionData}, so
   * ownership is unreachable from a public write.
   */
  private buildUpdateData(
    dto: UpdateVariantOptionDto,
  ): UpdateVariantOptionData {
    const data: UpdateVariantOptionData = {};

    if (dto.optionName !== undefined) {
      data.optionName = normalizeName(dto.optionName);
    }

    if (dto.optionValue !== undefined) {
      data.optionValue = normalizeName(dto.optionValue);
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
  ): Promise<void> {
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
  }

  /**
   * Walks the whole ownership chain before returning an option, otherwise 404.
   *
   * The product and variant are re-resolved here rather than trusted from an
   * earlier call so this helper is safe to use on its own from every method, and
   * one message covers "no such option" and "belongs to another variant".
   */
  private async requireOwnedOption(
    productId: string,
    variantId: string,
    optionId: string,
  ): Promise<VariantOption> {
    await this.requireProduct(productId);
    await this.requireOwnedVariant(productId, variantId);

    const option =
      await this.variantOptionsRepository.findByIdAndVariantId(
        optionId,
        variantId,
      );

    if (option === null) {
      throw new NotFoundException(`Variant option ${optionId} does not exist`);
    }

    return option;
  }

  /**
   * Rejects a duplicate option name with 409.
   *
   * The comparison is case-insensitive, so `Color` and `color` collide. This is a
   * pre-flight check so the client gets a deterministic message instead of a
   * constraint violation. It cannot fully replace the `P2002` mapping in
   * {@link rethrowAsHttpError}: two concurrent requests can both pass this check,
   * and only the database — through the functional unique index on
   * `lower(option_name)` — can settle the race.
   *
   * `excludeId` lets an update keep its own name (including a case-only change)
   * without colliding with itself.
   */
  private async assertOptionNameAvailable(
    variantId: string,
    optionName: string,
    excludeId?: string,
  ): Promise<void> {
    const existing =
      await this.variantOptionsRepository.findByVariantIdAndOptionName(
        variantId,
        optionName,
      );

    if (existing !== null && existing.id !== excludeId) {
      throw new ConflictException(DUPLICATE_OPTION_NAME_MESSAGE);
    }
  }

  /**
   * Translates the one Prisma error this feature can legitimately produce on a
   * write into HTTP semantics, and rethrows everything else unchanged.
   *
   * Only `P2002` on the option name is mapped. Any other known request error — a
   * connection failure, a deadlock, a foreign key violation, a missing table — is
   * a genuine fault and is allowed to surface as a 500 rather than being laundered
   * into a 4xx.
   */
  private rethrowAsHttpError(error: unknown): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === PRISMA_UNIQUE_CONSTRAINT_VIOLATION &&
      this.isOptionNameUniqueViolation(error)
    ) {
      throw new ConflictException(DUPLICATE_OPTION_NAME_MESSAGE);
    }

    throw error;
  }

  /**
   * Detects a unique constraint violation on the option name.
   *
   * Prisma only populates `meta.target` for engines that report it. With driver
   * adapters such as `@prisma/adapter-pg` the meta object carries only
   * `modelName` and `driverAdapterError`, so the model name is used as the
   * fallback. The primary key is a server-generated UUID, so a `P2002` on
   * `variant_options` is a duplicate option name in practice.
   */
  private isOptionNameUniqueViolation(
    error: Prisma.PrismaClientKnownRequestError,
  ): boolean {
    const meta = error.meta;
    const target = meta?.['target'];

    if (Array.isArray(target)) {
      return (
        target.includes(OPTION_NAME_FIELD) ||
        target.includes(OPTION_NAME_COLUMN)
      );
    }

    if (typeof target === 'string') {
      return (
        target === OPTION_NAME_FIELD || target === OPTION_NAME_COLUMN
      );
    }

    return meta?.['modelName'] === VARIANT_OPTION_MODEL;
  }
}
