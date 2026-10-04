import { toMoneyString } from '../../common/utils/money.js';
import type { OrderStatus } from '../constants/order-status.constants.js';
import type { OrderWithItems } from '../repositories/order.repository.js';
import { OrderItemResponseDto } from './order-item-response.dto.js';

/**
 * Outbound representation of a single order, as returned by `GET /orders/:id`.
 *
 * This is the complete customer-facing view of an order and it is built field by
 * field from the stored row. Nothing is spread, nothing is passed through, and no
 * relation other than `items` is ever selected by the repository — so there is no
 * path by which an unexpected column, a raw Prisma object or a `passwordHash`
 * could reach the client.
 *
 * ## The shipping fields are a snapshot
 *
 * All nine `shipping*` fields are copied onto the order itself rather than
 * referenced from `addresses`. They are deliberately *not* the current contents of
 * an address row: correcting a typo in the address book must not change where
 * last month's parcel went, and deleting an address must not erase the delivery
 * history of the order that used it. The trade-off is that an order and its
 * address can disagree — which is the correct behaviour, not a defect.
 *
 * Nullability is preserved exactly: `addressLine2`, `stateProvince` and
 * `postalCode` are `null` rather than an empty string when absent, because "not
 * supplied" and "supplied as blank" are different facts and a client rendering an
 * address should be able to tell.
 *
 * ## Money
 *
 * Every amount is a fixed two-decimal **string**. A JSON number cannot represent
 * every two-decimal value exactly, so returning numbers would let a figure drift
 * between the database and the client — the same reasoning as
 * `common/utils/money.ts`, applied to orders.
 *
 * `totalAmount` is read from its column, not recomputed. The database asserts
 * `total = subtotal + shippingFee - discountAmount` with a `CHECK` constraint, so
 * the stored figure is authoritative by construction, and recomputing it here would
 * duplicate arithmetic that is already enforced.
 *
 * There is no tax field. Tax is not modelled yet, and adding one later is additive
 * whereas a wrong tax figure frozen into an immutable total would not be.
 *
 * ## What this DTO deliberately omits
 *
 * - **`user` / `user` object.** Ownership is the `userId` scalar. The repository
 *   never selects the user relation, so no user column is in memory to leak.
 * - **`addressId`.** There is no such column and there never will be — see the
 *   snapshot note above.
 * - **Any mutation affordance.** No `links`, no `actions`, no `canCancel`. The
 *   API exposes no way to change an order, so advertising a capability would be a
 *   promise this phase does not keep.
 */
export class OrderResponseDto {
  id: string;
  userId: string;
  /** The customer-facing reference; `id` is internal and appears in URLs only. */
  orderNumber: string;
  status: OrderStatus;
  subtotal: string;
  shippingFee: string;
  discountAmount: string;
  totalAmount: string;
  currency: string;
  shippingRecipientName: string;
  shippingPhone: string;
  shippingAddressLine1: string;
  shippingAddressLine2: string | null;
  shippingCity: string;
  shippingStateProvince: string | null;
  shippingPostalCode: string | null;
  shippingCountryCode: string;
  items: OrderItemResponseDto[];
  /** Units across every line, so a client need not reduce the items itself. */
  itemCount: number;
  createdAt: Date;
  updatedAt: Date;

  static fromEntity(order: OrderWithItems): OrderResponseDto {
    const dto = new OrderResponseDto();
    const items = order.items.map((item) =>
      OrderItemResponseDto.fromEntity(item),
    );

    dto.id = order.id;
    dto.userId = order.userId;
    dto.orderNumber = order.orderNumber;
    dto.status = order.status as OrderStatus;
    dto.subtotal = toMoneyString(order.subtotal);
    dto.shippingFee = toMoneyString(order.shippingFee);
    dto.discountAmount = toMoneyString(order.discountAmount);
    dto.totalAmount = toMoneyString(order.totalAmount);
    dto.currency = order.currency;
    dto.shippingRecipientName = order.shippingRecipientName;
    dto.shippingPhone = order.shippingPhone;
    dto.shippingAddressLine1 = order.shippingAddressLine1;
    dto.shippingAddressLine2 = order.shippingAddressLine2;
    dto.shippingCity = order.shippingCity;
    dto.shippingStateProvince = order.shippingStateProvince;
    dto.shippingPostalCode = order.shippingPostalCode;
    dto.shippingCountryCode = order.shippingCountryCode;
    dto.items = items;
    dto.itemCount = items.reduce((total, item) => total + item.quantity, 0);
    dto.createdAt = order.createdAt;
    dto.updatedAt = order.updatedAt;
    return dto;
  }
}