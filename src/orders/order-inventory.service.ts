import { ConflictException, Injectable } from '@nestjs/common';
import type { Inventory } from '../generated/prisma/client.js';
import { InventoryRepository } from '../inventory/repositories/inventory.repository.js';
import {
  OrderRepository,
  type OrderTransactionClient,
} from './repositories/order.repository.js';

/** How an order's reserved stock leaves the ledger. */
type StockMovement = 'release' | 'commit';

/** One variant's total requirement, after duplicate order lines are merged. */
interface VariantQuantity {
  variantId: string;
  quantity: number;
}

/**
 * Turns an order's persisted lines into safe inventory movements.
 *
 * ## Why this exists
 *
 * Cancelling an order releases the stock it holds; shipping it commits that stock
 * out of the warehouse. Both are multi-line operations, and doing them naively is
 * unsafe in three separate ways:
 *
 * 1. **The quantity must not come from the caller.** A request body, an admin form
 *    or a frontend can say anything. The requirement is read from `order_items`
 *    inside the caller's transaction, so the movement always matches what the order
 *    actually recorded.
 * 2. **Duplicate lines must be merged.** `order_items` has no
 *    `(order_id, variant_id)` uniqueness on purpose — two lines of the same variant
 *    may have been priced differently. Moving stock once per line would still be
 *    correct only if each per-line guarded update happened to succeed; merging them
 *    into one total per variant makes the operation depend on the order's real
 *    requirement instead of the accidental shape of its receipt.
 * 3. **Variants must be visited in one global order.** Two multi-variant orders
 *    processed in opposite line order could take each other's row locks in opposite
 *    orders and deadlock. Grouping by variant and sorting the ids makes every caller
 *    take the same locks in the same sequence.
 *
 * ## Transaction ownership
 *
 * Neither method opens a transaction. Each takes the caller's
 * {@link OrderTransactionClient} and passes it to the order read and every counter
 * update. A failure on any variant therefore throws out of the caller's transaction,
 * which rolls back the updates that already succeeded. That is the only acceptable
 * outcome: an order cannot be half-cancelled, with some of its stock returned and
 * the rest still held.
 *
 * ## What is checked before any update
 *
 * The order's lines are read and grouped first, then every variant's inventory row
 * is fetched in one query. A missing row, a non-positive persisted quantity or an
 * incoherent pair (`reservedQuantity > quantity`, or a negative counter) is a
 * conflict raised before the first counter moves. Those are data-integrity faults,
 * not races, and there is nothing to roll back if they are found first.
 *
 * The guarded update is still the authority on whether the stock is *sufficient*.
 * This service does not pre-compute "is there enough" and then write, because that
 * is exactly the read-modify-write race the repository's SQL exists to remove. It
 * asks the statement to move the stock and treats an affected-row count other than
 * `1` as a conflict.
 *
 * ## What this service deliberately does not do
 *
 * It does not decide *whether* an order may be cancelled or shipped, and it does
 * not choose the resulting status. The customer cancellation, administrator
 * cancellation and shipment paths in `OrderService` own those rules and call these
 * methods inside the same transaction as their guarded status update. That guard
 * is what makes a repeated request a conflict before inventory moves, rather than
 * a second movement.
 */
@Injectable()
export class OrderInventoryService {
  constructor(
    private readonly orderRepository: OrderRepository,
    private readonly inventoryRepository: InventoryRepository,
  ) {}

  /**
   * Releases every reservation held by `orderId`.
   *
   * `reservedQuantity` falls by the order's per-variant total and `quantity` is
   * untouched: the physical stock never left the warehouse.
   *
   * @throws Conflict when the order has no lines, a persisted quantity is not a
   *   positive whole number, a variant has no inventory row, a row is incoherent,
   *   or the guarded release finds less reserved than the order requires.
   */
  releaseReservedForOrder(
    orderId: string,
    tx: OrderTransactionClient,
  ): Promise<void> {
    return this.applyForOrder(orderId, 'release', tx);
  }

  /**
   * Commits every reservation held by `orderId` when its stock ships.
   *
   * Both `quantity` and `reservedQuantity` fall by the order's per-variant total:
   * the units are no longer on hand and are no longer promised.
   *
   * @throws Conflict under the same conditions as
   *   {@link releaseReservedForOrder}, plus when the guarded commitment finds less
   *   physical stock or reservation than the order requires.
   */
  commitReservedForOrder(
    orderId: string,
    tx: OrderTransactionClient,
  ): Promise<void> {
    return this.applyForOrder(orderId, 'commit', tx);
  }

  /** Runs one movement for every variant of the order, in ascending id order. */
  private async applyForOrder(
    orderId: string,
    movement: StockMovement,
    tx: OrderTransactionClient,
  ): Promise<void> {
    const requirements = await this.requirementsForOrder(orderId, movement, tx);

    for (const { variantId, quantity } of requirements) {
      const changed =
        movement === 'release'
          ? await this.inventoryRepository.releaseReserved(
              variantId,
              quantity,
              tx,
            )
          : await this.inventoryRepository.commitReserved(
              variantId,
              quantity,
              tx,
            );

      if (changed !== 1) {
        throw new ConflictException(
          this.insufficientMessage(movement, variantId, quantity),
        );
      }
    }
  }

  /**
   * Reads the order's persisted lines, validates them, merges duplicate variants
   * and returns the requirements in ascending variant-id order.
   *
   * The inventory rows for those variants are fetched and checked here too, in one
   * query, so a missing or incoherent row fails before any counter is changed.
   */
  private async requirementsForOrder(
    orderId: string,
    movement: StockMovement,
    tx: OrderTransactionClient,
  ): Promise<VariantQuantity[]> {
    const lines = await this.orderRepository.findItemQuantitiesByOrderId(
      orderId,
      tx,
    );

    if (lines.length === 0) {
      throw new ConflictException(
        `Order ${orderId} has no lines to ${movement}`,
      );
    }

    const totals = new Map<string, number>();

    for (const line of lines) {
      if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
        throw new ConflictException(
          `Order ${orderId} has an invalid quantity for product variant ${line.variantId}`,
        );
      }

      const total = (totals.get(line.variantId) ?? 0) + line.quantity;

      if (!Number.isSafeInteger(total)) {
        throw new ConflictException(
          `Order ${orderId} has too many units for product variant ${line.variantId}`,
        );
      }

      totals.set(line.variantId, total);
    }

    const requirements = [...totals.entries()]
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([variantId, quantity]) => ({ variantId, quantity }));

    await this.assertInventoryReady(requirements, tx);

    return requirements;
  }

  /**
   * Fetches every required variant's inventory row and rejects a missing or
   * incoherent one before any movement starts.
   *
   * `reservedQuantity > quantity` and a negative counter cannot be produced through
   * the table's `CHECK` constraints, but reading them as impossible rather than
   * assuming it is how a damaged row is prevented from being silently "repaired" by
   * the arithmetic of a release or commitment. The guarded statements remain the
   * authority on sufficiency; this is only the integrity check.
   */
  private async assertInventoryReady(
    requirements: VariantQuantity[],
    tx: OrderTransactionClient,
  ): Promise<void> {
    const rows = await this.inventoryRepository.findByVariantIds(
      requirements.map((requirement) => requirement.variantId),
      tx,
    );
    const byVariantId = new Map<string, Inventory>();

    for (const row of rows) {
      byVariantId.set(row.variantId, row);
    }

    for (const { variantId } of requirements) {
      const inventory = byVariantId.get(variantId);

      if (inventory === undefined) {
        throw new ConflictException(
          `Product variant ${variantId} has no inventory row`,
        );
      }

      if (
        !Number.isInteger(inventory.quantity) ||
        !Number.isInteger(inventory.reservedQuantity) ||
        inventory.quantity < 0 ||
        inventory.reservedQuantity < 0 ||
        inventory.reservedQuantity > inventory.quantity
      ) {
        throw new ConflictException(
          `Inventory for product variant ${variantId} is inconsistent`,
        );
      }
    }
  }

  /** The one message shape a failed guarded movement produces. */
  private insufficientMessage(
    movement: StockMovement,
    variantId: string,
    quantity: number,
  ): string {
    return movement === 'release'
      ? `Reserved stock for product variant ${variantId} is insufficient to release ${quantity}`
      : `Stock for product variant ${variantId} is insufficient to commit ${quantity}`;
  }
}
