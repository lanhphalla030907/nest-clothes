import { OrderResponseDto } from '../../orders/dto/order-response.dto.js';
import type { OrderWithItems } from '../../orders/repositories/order.repository.js';

/**
 * What `POST /checkout` returns: the order that was just placed.
 *
 * It is an **explicit named contract for checkout**, separate from
 * {@link OrderResponseDto} only so the checkout route's response is stated in its
 * own terms and has one place to grow. It deliberately adds no fields: the mapping
 * is delegated rather than copied, so a checkout receipt and a later
 * `GET /orders/:id` of the same order are byte-identical, and there is no second
 * copy of the mapping to drift.
 *
 * What the client gets is a receipt, so it carries the whole order:
 *
 * - `orderNumber` and `status`, because "where is my order" is answered by a human
 *   reading a number aloud;
 * - every money figure as a string with exactly two decimals, so no client has to
 *   trust its own float arithmetic against ours;
 * - the **shipping address as it was at checkout**, not a link to an address row;
 * - `items`, each one rendered from its own immutable snapshot, and `itemCount`, the
 *   number of units rather than the number of lines.
 *
 * What the client never gets:
 *
 * - `passwordHash` or any part of the `User` relation — the response is built field
 *   by field, so no user column can reach it even by accident;
 * - any **inventory** field. `reservedQuantity` is an internal ledger the customer
 *   neither supplied nor needs; exposing it would invite clients to reason about
 *   stock holds that belong to other people's orders;
 * - a raw Prisma entity. {@link OrderResponseDto} projects explicitly, which is what
 *   keeps a future column on `orders` from being published without a decision.
 */
export class CheckoutResponseDto extends OrderResponseDto {
  /**
   * Projects the order just written into the checkout receipt.
   *
   * The order is the freshly created entity, read back inside the same transaction
   * that wrote it, so the numbers in the receipt are the numbers that were persisted
   * rather than the ones the service happened to compute.
   */
  static fromOrder(order: OrderWithItems): CheckoutResponseDto {
    const projected = OrderResponseDto.fromEntity(order);
    const dto = new CheckoutResponseDto();

    // Copied key by key rather than spread, so a key added to the parent DTO has to
    // be added here deliberately — which is the point of naming the receipt.
    Object.assign(dto, projected);

    return dto;
  }
}
