import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import {
  availableStock,
  stockStatusFor,
  type StockStatus,
} from '../common/utils/available-stock.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { ProductVariantsRepository } from '../product-variants/repositories/product-variants.repository.js';
import { ProductsRepository } from '../products/repositories/products.repository.js';
import { CreateInventoryDto } from './dto/create-inventory.dto.js';
import {
  BulkInventoryOperation,
  type BulkInventoryDto,
} from './dto/bulk-inventory.dto.js';
import { InventoryResponseDto } from './dto/inventory-response.dto.js';
import { UpdateInventoryDto } from './dto/update-inventory.dto.js';
import {
  StockAlertItemDto,
  StockAlertSummaryDto,
  StockAlertsPaginationDto,
  StockAlertsResponseDto,
} from './dto/stock-alerts-response.dto.js';
import { StockAlertsQueryDto } from './dto/stock-alerts-query.dto.js';
import {
  InventoryRepository,
  type InventoryWithVariant,
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
const MAX_INVENTORY_QUANTITY = 2_147_483_647;
const MAX_BULK_VARIANTS = 500;
const STALE_BULK_INVENTORY_MESSAGE =
  'Stock changed after the preview. Refresh the matrix and review the changes again.';

/**
 * Reads one option pair by name, case-insensitively.
 *
 * The legacy `VariantOption` rows are kept in sync by the product option matrix,
 * so they are the one place colour/size can be read for every variant. A variant
 * without that option returns `null` rather than an empty string.
 */
const optionValue = (
  options: Array<{ optionName: string; optionValue: string }>,
  name: string,
): string | null =>
  options.find((option) => option.optionName.toLowerCase() === name)
    ?.optionValue ?? null;

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
    private readonly notificationsService: NotificationsService,
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

      const next = stockStatusFor(availableStock(inventory));
      void this.notificationsService.notifyStockTransition(
        variantId,
        'IN_STOCK',
        next,
      );

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

  async findStockAlerts(
    query: StockAlertsQueryDto,
  ): Promise<StockAlertsResponseDto> {
    const { page = 1, limit = 10, search, status = 'alerts' } = query;

    const result = await this.inventoryRepository.findStockAlertsPage({
      page,
      limit,
      search,
      status,
    });

    const response = new StockAlertsResponseDto();
    response.summary = new StockAlertSummaryDto();
    response.summary.inStock = result.inStock;
    response.summary.lowStock = result.lowStock;
    response.summary.outOfStock = result.outOfStock;
    response.summary.total = result.total;
    response.items = result.items.map((row) => this.toStockAlertItem(row));
    response.pagination = new StockAlertsPaginationDto();
    response.pagination.page = page;
    response.pagination.limit = limit;
    response.pagination.total = result.total;
    response.pagination.totalPages = Math.ceil(result.total / limit);
    return response;
  }

  private toStockAlertItem(row: InventoryWithVariant): StockAlertItemDto {
    const available = availableStock(row);

    const item = new StockAlertItemDto();
    item.variantId = row.variantId;
    item.productId = row.variant.productId;
    item.productName = row.variant.product.name;
    item.productImage = row.variant.product.images[0]?.imageUrl ?? null;
    item.sku = row.variant.sku;
    item.color = optionValue(row.variant.options, 'color');
    item.size = optionValue(row.variant.options, 'size');
    item.quantity = row.quantity;
    item.reservedQuantity = row.reservedQuantity;
    item.available = available;
    item.status = stockStatusFor(available);
    return item;
  }

  async update(
    productId: string,
    variantId: string,
    dto: UpdateInventoryDto,
  ): Promise<InventoryResponseDto> {
    await this.requireProduct(productId);
    await this.requireOwnedVariant(productId, variantId);

    const result = await this.inventoryRepository.runInTransaction(async (tx) => {
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
      const reservedQuantity = dto.reservedQuantity ?? current.reservedQuantity;

      this.assertCountersWithinInvariants(quantity, reservedQuantity);

      try {
        const inventory = await this.inventoryRepository.update(
          variantId,
          this.buildUpdateData(dto),
          tx,
        );

        return {
          response: InventoryResponseDto.fromEntity(inventory),
          previous: stockStatusFor(availableStock(current)),
          next: stockStatusFor(availableStock(inventory)),
        };
      } catch (error) {
        this.rethrowAsHttpError(error);
      }
    });

    void this.notificationsService.notifyStockTransition(
      variantId,
      result.previous,
      result.next,
    );
    return result.response;
  }

  async bulkUpdate(
    productId: string,
    dto: BulkInventoryDto,
  ): Promise<InventoryResponseDto[]> {
    if (
      !Object.values(BulkInventoryOperation).includes(dto.operation) ||
      !Number.isInteger(dto.quantity) ||
      dto.quantity < 0 ||
      dto.quantity > MAX_INVENTORY_QUANTITY
    ) {
      throw new BadRequestException(
        'The bulk stock action or amount is invalid',
      );
    }
    if (
      dto.variantIds.length === 0 ||
      dto.variantIds.length > MAX_BULK_VARIANTS ||
      new Set(dto.variantIds).size !== dto.variantIds.length
    ) {
      throw new BadRequestException(
        `Select between 1 and ${MAX_BULK_VARIANTS} unique variants`,
      );
    }
    if (dto.operation !== BulkInventoryOperation.SET && dto.quantity <= 0) {
      throw new BadRequestException(
        'Increase and decrease amounts must be greater than zero',
      );
    }

    await this.requireProduct(productId);
    const variants = await this.productVariantsRepository.findByIdsAndProductId(
      dto.variantIds,
      productId,
    );
    if (variants.length !== dto.variantIds.length) {
      throw new NotFoundException(
        'One or more selected variants do not belong to this product',
      );
    }

    try {
      const result = await this.inventoryRepository.runInTransaction(async (tx) => {
        await this.inventoryRepository.lockByVariantIds(dto.variantIds, tx);
        const currentRows = await this.inventoryRepository.findByVariantIds(
          dto.variantIds,
          tx,
        );

        const currentByVariant = new Map(
          currentRows.map((row) => [row.variantId, row]),
        );
        const expectedByVariant = new Map(
          dto.expectedInventory.map((row) => [row.variantId, row]),
        );
        if (
          expectedByVariant.size !== dto.variantIds.length ||
          dto.variantIds.some((variantId) => !expectedByVariant.has(variantId))
        ) {
          throw new BadRequestException(
            'Provide the current inventory state for every selected variant',
          );
        }

        const quantities = dto.variantIds.map((variantId) => {
          const current = currentByVariant.get(variantId);
          const expected = expectedByVariant.get(variantId);
          if (expected === undefined) {
            throw new BadRequestException(
              'Provide the current inventory state for every selected variant',
            );
          }
          const inventoryExists = expected.inventoryExists ?? true;
          const currentQuantity = current?.quantity ?? DEFAULT_COUNTER;
          const currentReservedQuantity =
            current?.reservedQuantity ?? DEFAULT_COUNTER;
          if (
            inventoryExists !== (current !== undefined) ||
            expected.quantity !== currentQuantity ||
            expected.reservedQuantity !== currentReservedQuantity
          ) {
            throw new ConflictException(STALE_BULK_INVENTORY_MESSAGE);
          }

          const quantity = this.resolveBulkQuantity(
            currentQuantity,
            currentReservedQuantity,
            dto,
          );
          this.assertCountersWithinInvariants(
            quantity,
            currentReservedQuantity,
          );

          return {
            variantId,
            quantity,
            inventoryExists: current !== undefined,
          };
        });

        const updated: Array<{
          response: InventoryResponseDto;
          previous: StockStatus;
          next: StockStatus;
        }> = [];
        for (const { variantId, quantity, inventoryExists } of quantities) {
          const inventory = inventoryExists
            ? await this.inventoryRepository.update(variantId, { quantity }, tx)
            : await this.inventoryRepository.create(
                {
                  variantId,
                  quantity,
                  reservedQuantity: DEFAULT_COUNTER,
                },
                tx,
              );
          updated.push({
            response: InventoryResponseDto.fromEntity(inventory),
            previous: stockStatusFor(
              currentByVariant.has(variantId)
                ? availableStock(currentByVariant.get(variantId)!)
                : DEFAULT_COUNTER,
            ),
            next: stockStatusFor(availableStock(inventory)),
          });
        }
        return updated;
      });
      for (const { response, previous, next } of result) {
        void this.notificationsService.notifyStockTransition(
          response.variantId,
          previous,
          next,
        );
      }
      return result.map(({ response }) => response);
    } catch (error) {
      this.rethrowAsHttpError(error);
    }
  }

  private resolveBulkQuantity(
    currentQuantity: number,
    reservedQuantity: number,
    dto: BulkInventoryDto,
  ): number {
    const quantity =
      dto.operation === BulkInventoryOperation.SET
        ? dto.quantity
        : dto.operation === BulkInventoryOperation.INCREASE
          ? currentQuantity + dto.quantity
          : currentQuantity - dto.quantity;

    if (
      quantity > MAX_INVENTORY_QUANTITY ||
      quantity < 0 ||
      quantity < reservedQuantity
    ) {
      throw new BadRequestException(
        'Bulk stock changes cannot set quantity below reserved stock or outside the supported range',
      );
    }

    return quantity;
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
    const variant = await this.productVariantsRepository.findByIdAndProductId(
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
        target.includes(VARIANT_ID_FIELD) || target.includes(VARIANT_ID_COLUMN)
      );
    }

    if (typeof target === 'string') {
      return target === VARIANT_ID_FIELD || target === VARIANT_ID_COLUMN;
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
