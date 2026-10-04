import { Prisma } from '../../generated/prisma/client.js';
import { toMoneyString } from '../../common/utils/money.js';
import type { OrderStatus } from '../constants/order-status.constants.js';
import { ORDER_STATUS } from '../constants/order-status.constants.js';
import type { OrderWithItems } from '../repositories/order.repository.js';
import { OrderItemResponseDto } from './order-item-response.dto.js';

/**
 * The fields a client needs to render one row of "my orders", and nothing else.
 *
 * A *separate* DTO from {@link OrderResponseDto}, not a subset of it, for two
 * reasons:
 *
 * - **The listing and the detail view have different jobs.** The list needs enough
 *   to draw a row; the detail needs the full shipping address. Shipping details
 *   are excluded here so an order index does not carry a dozen address fields the
 *   client never displays.
 * - **A shared DTO would leak through every future change.** If both responses
 *   used one type, adding a field to the detail view would silently add it to the
 *   listing too. Two types make the two contracts explicit and independently
 *   reviewable.
 *
 * The address that *is* included (`recipientName`, `city`, `countryCode`) is what
 * a customer needs to recognise an order at a glance — "to Sarah in Bristol" — and
 * it comes from the order's own immutable snapshot, so it cannot be changed by
 * editing an address in the address book.
 *
 * ## No `user` object, no `passwordHash`
 *
 * Ownership is the `userId` scalar. The repository never selects the `user`
 * relation, so no user column is even in memory to be serialised — least of all
 * `passwordHash`. An order response has no business carrying account data.
 */
export class OrderSummaryResponseDto {
  id: string;
  userId: string;
  /** The customer-facing reference. See `OrderNumberGenerator`. */
  orderNumber: string;
  status: OrderStatus;
  /** Sum of every line's `lineTotal`, as a fixed two-decimal string. */
  subtotal: string;
  shippingFee: string;
  discountAmount: string;
  /** `subtotal + shippingFee - discountAmount`, as a fixed two-decimal string. */
  totalAmount: string;
  /** ISO 4217 alphabetic code, for example `USD`. */
  currency: string;
  /** Total units across every line — a bag count, not a line count. */
  itemCount: number;
  /** How many lines the order has. */
  lineCount: number;
  /** From the snapshot, not from a live address row. */
  shippingRecipientName: string;
  shippingCity: string;
  shippingCountryCode: string;
  createdAt: Date;
  updatedAt: Date;

  static fromEntity(order: OrderWithItems): OrderSummaryResponseDto {
    const dto = new OrderSummaryResponseDto();
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
    dto.itemCount = items.reduce((total, item) => total + item.quantity, 0);
    dto.lineCount = items.length;
    dto.shippingRecipientName = order.shippingRecipientName;
    dto.shippingCity = order.shippingCity;
    dto.shippingCountryCode = order.shippingCountryCode;
    dto.createdAt = order.createdAt;
    dto.updatedAt = order.updatedAt;
    return dto;
  }

  /**
   * Cross-checks the stored totals against the stored lines.
   *
   * Exposed for tests and for a future data-integrity report; **never called on a
   * request path**. The database already guarantees
   * `total = subtotal + shippingFee - discountAmount` and `lineTotal =
   * unitPrice * quantity` through `CHECK` constraints, so a mismatch here means the
   * database was altered by something other than these migrations.
   *
   * Kept as `Decimal` arithmetic rather than `parseFloat` because a float would
   * report a spurious mismatch on a value that is actually correct.
   */
  static reconcilesWithItems(order: OrderWithItems): boolean {
    const lineSum = order.items.reduce(
      (total, item) => total.plus(item.lineTotal),
      new Prisma.Decimal(0),
    );

    const expectedTotal = order.subtotal
      .plus(order.shippingFee)
      .minus(order.discountAmount);

    return (
      lineSum.equals(order.subtotal) && expectedTotal.equals(order.totalAmount)
    );
  }

  /** The status literals this DTO is allowed to emit. Guards against a bad cast. */
  static readonly KNOWN_STATUSES: readonly OrderStatus[] =
    Object.values(ORDER_STATUS);
}