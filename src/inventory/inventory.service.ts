import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { ProductVariantsRepository } from '../product-variants/repositories/product-variants.repository.js';
import { ProductsRepository } from '../products/repositories/products.repository.js';
import { CreateInventoryDto } from './dto/create-inventory.dto.js';
import { InventoryResponseDto } from './dto/inventory-response.dto.js';
import { UpdateInventoryDto } from './dto/update-inventory.dto.js';
import {
  InventoryRepository,
  type UpdateInventoryData,
} from './repositories/inventory.repository.js';

const PRISMA_UNIQUE_CONSTRAINT_VIOLATION = 'P2002';
const PRISMA_CONSTRAINT_VIOLATION = 'P2004';
const INVENTORY_MODEL = 'Inventory';
const VARIANT_ID_FIELD = 'variantId';
const VARIANT_ID_COLUMN = 'variant_id';
const POSTGRES_CHECK_VIOLATION = '23514';
const DUPLICATE_INVENTORY_MESSAGE =
  'Inventory already exists for this product variant';
const INVALID_COUNTERS_MESSAGE =
  'reservedQuantity must be greater than or equal to 0 and less than or equal to quantity';
const DEFAULT_COUNTER = 0;

/**
 * All inventory business rules live here; the repository only knows about SQL and
 * the controller only knows about HTTP.
 *
 * ## Ownership
 *
 * `productId` and `variantId` always come from the URL. The whole chain must
 * hold — the product must exist and the variant must belong to it — before an
 * inventory row is addressed. Any mismatch is a 404, and the inventory lookup is
 * scoped to the variant, so "no inventory" and "inventory of another variant" are
 * indistinguishable.
 *
 * ## Invariants
 *
 * Stock has two counters, `quantity` and `reservedQuantity`, whose rules are:
 * both are non-negative and `reservedQuantity <= quantity`. The derived
 * `available = quantity - reservedQuantity` is computed on read and never stored.
 *
 * A `PATCH` sends absolute counter values, not deltas, so the service cannot
 * "read available and write it back". It reads the current row *inside a
 * transaction*, fills the counters the request left out from that row, validates
 * the merged pair, and then writes only the counters the request actually sent.
 * Because unspecified counters are not rewritten, two concurrent patches that
 * touch different counters do not clobber each other. The table's `CHECK`
 * constraints are the final backstop: a write that would persist an invalid pair
 * — because a concurrent writer changed the other counter after the read — is
 * rejected by the database and translated to a 400.
 *
 * ## Error semantics
 *
 * | Condition                                                     | Status | Rationale                                                  |
 * | ------------------------------------------------------------- | ------ | ---------------------------------------------------------- |
 * | Malformed product or variant UUID                             | 400    | Rejected by `ParseUUIDPipe`, before the service.           |
 * | Invalid payload (non-integer, negative)                       | 400    | Rejected by the DTO validators.                            |
 * | `reservedQuantity > quantity` (or a negative counter)         | 400    | The merged pair violates a stock invariant.                |
 * | Product does not exist                                        | 404    | The addressed resource is absent.                          |
 * | Variant does not exist or belongs to another product          | 404    | Same 404, so ownership cannot be probed.                   |
 * | Inventory does not exist for the variant                      | 404    | The addressed resource is absent.                          |
 * | Inventory already exists for the variant                      | 409    | The request collides with the unique owner constraint.     |
 *
 * A foreign key failure on write (`P2003`) is *not* mapped: by the time
 * inventory is written its variant has already been validated, so a violation
 * means the variant was removed concurrently — a genuine fault that must surface
 * as a 500 rather than invite the client to retry blindly.
 */
@Injectable()
export class InventoryService {
  constructor(
    private readonly inventoryRepository: InventoryRepository,
    private readonly productVariantsRepository: ProductVariantsRepository,
    private readonly productsRepository: ProductsRepository,
  ) {}

  async create(
    productId: string,
    variantId: string,
    dto: CreateInventoryDto,
  ): Promise<InventoryResponseDto> {
    await this.requireProduct(productId);
    await this.requireOwnedVariant(productId, variantId);

    const quantity = dto.quantity ?? DEFAULT_COUNTER;
    const reservedQuantity = dto.reservedQuantity ?? DEFAULT_COUNTER;

    this.assertCountersWithinInvariants(quantity, reservedQuantity);

    await this.assertInventoryAbsent(variantId);

    try {
      const inventory = await this.inventoryRepository.create({
        variantId,
        quantity,
        reservedQuantity,
      });

      return InventoryResponseDto.fromEntity(inventory);
    } catch (error) {
      this.rethrowAsHttpError(error);
    }
  }

  async findOne(
    productId: string,
    variantId: string,
  ): Promise<InventoryResponseDto> {
    await this.requireProduct(productId);
    await this.requireOwnedVariant(productId, variantId);

    const inventory = await this.inventoryRepository.findByVariantId(variantId);

    if (inventory === null) {
      throw new NotFoundException(
        `Inventory for product variant ${variantId} does not exist`,
      );
    }

    return InventoryResponseDto.fromEntity(inventory);
  }

  async update(
    productId: string,
    variantId: string,
    dto: UpdateInventoryDto,
  ): Promise<InventoryResponseDto> {
    await this.requireProduct(productId);
    await this.requireOwnedVariant(productId, variantId);

    return this.inventoryRepository.runInTransaction(async (tx) => {
      const current = await this.inventoryRepository.findByVariantId(
        variantId,
        tx,
      );

      if (current === null) {
        throw new NotFoundException(
          `Inventory for product variant ${variantId} does not exist`,
        );
      }

      const quantity = dto.quantity ?? current.quantity;
      const reservedQuantity =
        dto.reservedQuantity ?? current.reservedQuantity;

      this.assertCountersWithinInvariants(quantity, reservedQuantity);

      try {
        const inventory = await this.inventoryRepository.update(
          variantId,
          this.buildUpdateData(dto),
          tx,
        );

        return InventoryResponseDto.fromEntity(inventory);
      } catch (error) {
        this.rethrowAsHttpError(error);
      }
    });
  }

  /**
   * Builds the update payload from the counters the client actually sent.
   *
   * An absent key is left out of the object entirely, so a request that changes
   * only one counter does not also rewrite the other from a possibly-stale read.
   * `variantId` cannot appear here at all: it is absent from `UpdateInventoryDto`
   * and from the repository's update type, so ownership is unreachable from a
   * public write.
   */
  private buildUpdateData(dto: UpdateInventoryDto): UpdateInventoryData {
    const data: UpdateInventoryData = {};

    if (dto.quantity !== undefined) {
      data.quantity = dto.quantity;
    }

    if (dto.reservedQuantity !== undefined) {
      data.reservedQuantity = dto.reservedQuantity;
    }

    return data;
  }

  /**
   * Rejects a pair of counters that violates the stock invariants.
   *
   * `@Min(0)` on the DTO already rejects a negative value the client sent, but a
   * counter inherited from the current row through a `PATCH` merge is checked
   * here too, and this is where the cross-field rule `reservedQuantity <=
   * quantity` lives. The database enforces the same rules with `CHECK`
   * constraints; this method exists so the client gets a deterministic 400.
   */
  private assertCountersWithinInvariants(
    quantity: number,
    reservedQuantity: number,
  ): void {
    if (
      !Number.isInteger(quantity) ||
      !Number.isInteger(reservedQuantity) ||
      quantity < 0 ||
      reservedQuantity < 0 ||
      reservedQuantity > quantity
    ) {
      throw new BadRequestException(INVALID_COUNTERS_MESSAGE);
    }
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
   * Rejects a second inventory row for the same variant with 409.
   *
   * This is a pre-flight check so the client gets a deterministic message instead
   * of a constraint violation. It cannot fully replace the `P2002` mapping in
   * {@link rethrowAsHttpError}: two concurrent creates can both pass this check,
   * and only the unique index on `variant_id` can settle the race.
   */
  private async assertInventoryAbsent(variantId: string): Promise<void> {
    const existing = await this.inventoryRepository.findByVariantId(variantId);

    if (existing !== null) {
      throw new ConflictException(DUPLICATE_INVENTORY_MESSAGE);
    }
  }

  /**
   * Translates the database errors this feature can legitimately produce on a
   * write into HTTP semantics, and rethrows everything else unchanged.
   *
   * A unique violation (`P2002`) is a duplicate inventory row. A check violation
   * (`23514`, surfaced by Prisma as `P2004`) means a concurrent writer changed
   * the other counter between the read and the write, so the merged pair the
   * service validated no longer holds; that is reported as a 400. Any other known
   * request error is a genuine fault and surfaces as a 500 rather than being
   * laundered into a 4xx.
   */
  private rethrowAsHttpError(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (
        error.code === PRISMA_UNIQUE_CONSTRAINT_VIOLATION &&
        this.isInventoryUniqueViolation(error)
      ) {
        throw new ConflictException(DUPLICATE_INVENTORY_MESSAGE);
      }

      if (
        error.code === PRISMA_CONSTRAINT_VIOLATION ||
        this.isCheckConstraintViolation(error)
      ) {
        throw new BadRequestException(INVALID_COUNTERS_MESSAGE);
      }
    }

    throw error;
  }

  /**
   * Detects a unique constraint violation on `inventory.variant_id`.
   *
   * Prisma only populates `meta.target` for engines that report it. With driver
   * adapters such as `@prisma/adapter-pg` the meta object carries a
   * `driverAdapterError`, so the model name is used as the fallback. A `P2002` on
   * `inventory` can only be the unique `variant_id` — the primary key is a
   * server-generated UUID — so the model check is sufficient.
   */
  private isInventoryUniqueViolation(
    error: Prisma.PrismaClientKnownRequestError,
  ): boolean {
    const meta = error.meta;
    const target = meta?.['target'];

    if (Array.isArray(target)) {
      return (
        target.includes(VARIANT_ID_FIELD) ||
        target.includes(VARIANT_ID_COLUMN)
      );
    }

    if (typeof target === 'string') {
      return (
        target === VARIANT_ID_FIELD || target === VARIANT_ID_COLUMN
      );
    }

    return meta?.['modelName'] === INVENTORY_MODEL;
  }

  /**
   * Detects a Postgres check-constraint violation raised by the inventory
   * counters.
   *
   * The driver adapter reports the underlying SQLSTATE in
   * `meta.driverAdapterError.cause.originalCode`; `23514` is
   * `check_violation`. The kind name is checked too so the detection survives a
   * change in how the adapter labels the cause.
   */
  private isCheckConstraintViolation(
    error: Prisma.PrismaClientKnownRequestError,
  ): boolean {
    const meta = error.meta as
      | {
          driverAdapterError?: {
            cause?: { originalCode?: string; kind?: string };
          };
        }
      | undefined;
    const cause = meta?.driverAdapterError?.cause;

    if (cause?.originalCode === POSTGRES_CHECK_VIOLATION) {
      return true;
    }

    return (
      typeof cause?.kind === 'string' &&
      cause.kind.toLowerCase().includes('check')
    );
  }
}
