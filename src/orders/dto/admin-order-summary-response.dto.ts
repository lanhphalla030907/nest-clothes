import { toMoneyString } from '../../common/utils/money.js';
import type { OrderStatus } from '../constants/order-status.constants.js';
import type { AdminOrderListRow } from '../repositories/order.repository.js';
import { AdminOrderCustomerDto } from './admin-order-customer.dto.js';
import { AdminOrderPaymentSummaryDto } from './admin-order-payment.dto.js';
import {
  toShippingLocationPath,
  type ShippingLocationSnapshotEntry,
} from './shipping-location-snapshot.dto.js';

/**
 * One row of the administrative order listing.
 *
 * This is deliberately a separate type from the customer's
 * {@link OrderSummaryResponseDto}. It adds the customer identity and a payment
 * summary, which a customer does not need, and omits nothing that a customer
 * sees except `userId`, which is already represented by `customer.id`.
 *
 * Money is serialised with the project's fixed two-decimal string convention.
 * `itemCount` is total units, `lineCount` is the number of order lines.
 */
export class AdminOrderSummaryResponseDto {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  customer: AdminOrderCustomerDto;
  subtotal: string;
  shippingFee: string;
  discountAmount: string;
  totalAmount: string;
  currency: string;
  itemCount: number;
  lineCount: number;
  /** Selected immutable shipping-snapshot fields, enough to recognise an order. */
  shippingRecipientName: string;
  shippingCity: string | null;
  shippingLocationPath: ShippingLocationSnapshotEntry[] | null;
  shippingCountryCode: string;
  /** The most recent payment attempt, or `null` when none was ever started. */
  payment: AdminOrderPaymentSummaryDto | null;
  /** Whether any attempt on this order has reached `PAID`. */
  hasPaidPayment: boolean;
  /** The payment channel selected at checkout, independent of any attempt. */
  paymentMethod: string | null;
  createdAt: Date;
  updatedAt: Date;

  static fromEntity(order: AdminOrderListRow): AdminOrderSummaryResponseDto {
    const dto = new AdminOrderSummaryResponseDto();
    const latestPayment = order.payments[0];

    dto.id = order.id;
    dto.orderNumber = order.orderNumber;
    dto.status = order.status as OrderStatus;
    dto.customer = AdminOrderCustomerDto.fromEntity(order.user);
    dto.subtotal = toMoneyString(order.subtotal);
    dto.shippingFee = toMoneyString(order.shippingFee);
    dto.discountAmount = toMoneyString(order.discountAmount);
    dto.totalAmount = toMoneyString(order.totalAmount);
    dto.currency = order.currency;
    dto.itemCount = order.items.reduce(
      (total, item) => total + item.quantity,
      0,
    );
    dto.lineCount = order.items.length;
    dto.shippingRecipientName = order.shippingRecipientName;
    dto.shippingCity = order.shippingCity;
    dto.shippingLocationPath = toShippingLocationPath(
      order.shippingLocationSnapshot,
    );
    dto.shippingCountryCode = order.shippingCountryCode;
    dto.payment =
      latestPayment === undefined
        ? null
        : AdminOrderPaymentSummaryDto.fromEntity(latestPayment);
    dto.hasPaidPayment = order._count.payments > 0;
    dto.paymentMethod = order.paymentMethod ?? null;
    dto.createdAt = order.createdAt;
    dto.updatedAt = order.updatedAt;
    return dto;
  }
}
