import type { Inventory } from '../../generated/prisma/client.js';

/**
 * Outbound representation of an inventory row.
 *
 * Exactly the stored columns are exposed, plus the derived `available` amount.
 * There is no nested `variant` to leak even if Prisma ever joins the relation,
 * because `fromEntity` copies field by field rather than spreading the entity.
 * Inventory must always be mapped through this DTO.
 *
 * `available` is computed here, on the way out, and is never stored: it is
 * `quantity - reservedQuantity`, so exposing it as a separate column would create
 * a value that could drift from the two counters it is derived from.
 */
export class InventoryResponseDto {
  id: string;
  variantId: string;
  quantity: number;
  reservedQuantity: number;
  /**
   * The sellable amount: `quantity - reservedQuantity`. Always a whole number
   * because both counters are integers.
   */
  available: number;
  createdAt: Date;
  updatedAt: Date;

  static fromEntity(inventory: Inventory): InventoryResponseDto {
    const dto = new InventoryResponseDto();

    dto.id = inventory.id;
    dto.variantId = inventory.variantId;
    dto.quantity = inventory.quantity;
    dto.reservedQuantity = inventory.reservedQuantity;
    dto.available = inventory.quantity - inventory.reservedQuantity;
    dto.createdAt = inventory.createdAt;
    dto.updatedAt = inventory.updatedAt;
    return dto;
  }
}
