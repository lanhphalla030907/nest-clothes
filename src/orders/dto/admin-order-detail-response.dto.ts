import { toMoneyString } from '../../common/utils/money.js';
import type { OrderStatus } from '../constants/order-status.constants.js';
import type { AdminOrderDetailRow } from '../repositories/order.repository.js';
import { AdminOrderCustomerDto } from './admin-order-customer.dto.js';
import { OrderItemResponseDto } from './order-item-response.dto.js';
import { AdminOrderPaymentDto } from './admin-order-payment.dto.js';
import {
  toShippingLocationPath,
  type ShippingLocationSnapshotEntry,
} from './shipping-location-snapshot.dto.js';

/**
 * The complete administrative view of one order.
 *
 * It carries the stored order fields, the immutable shipping snapshot, the
 * immutable item snapshots and every payment attempt in a safe projection. No
 * value is derived from the live catalogue: `items` is mapped from the order
 * line's own columns, so a product rename or repricing after the sale cannot
 * rewrite the receipt.
 *
 * Payment attempts are newest first, including failed and expired ones. That is
 * the audit trail an operator needs; `qrPayload` and any provider callback body
 * are never selected and therefore cannot appear here.
 */
export class AdminOrderDetailResponseDto {
  id: string;
  userId: string;
  orderNumber: string;
  status: OrderStatus;
  subtotal: string;
  shippingFee: string;
  discountAmount: string;
  totalAmount: string;
  currency: string;
  customer: AdminOrderCustomerDto;
  /** The immutable shipping snapshot copied onto the order at checkout. */
  shippingRecipientName: string;
  shippingPhone: string;
  shippingAddressLine1: string;
  shippingAddressLine2: string | null;
  shippingCity: string | null;
  shippingStateProvince: string | null;
  shippingLocationPath: ShippingLocationSnapshotEntry[] | null;
  shippingPostalCode: string | null;
  shippingCountryCode: string;
  items: OrderItemResponseDto[];
  payments: AdminOrderPaymentDto[];
  itemCount: number;
  lineCount: number;
  createdAt: Date;
  updatedAt: Date;
  /** The payment channel selected at checkout, independent of any attempt. */
  paymentMethod: string | null;

  static fromEntity(order: AdminOrderDetailRow): AdminOrderDetailResponseDto {
    const dto = new AdminOrderDetailResponseDto();
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
    dto.customer = AdminOrderCustomerDto.fromEntity(order.user);
    dto.shippingRecipientName = order.shippingRecipientName;
    dto.shippingPhone = order.shippingPhone;
    dto.shippingAddressLine1 = order.shippingAddressLine1;
    dto.shippingAddressLine2 = order.shippingAddressLine2;
    dto.shippingCity = order.shippingCity;
    dto.shippingStateProvince = order.shippingStateProvince;
    dto.shippingLocationPath = toShippingLocationPath(
      order.shippingLocationSnapshot,
    );
    dto.shippingPostalCode = order.shippingPostalCode;
    dto.shippingCountryCode = order.shippingCountryCode;
    dto.items = items;
    dto.payments = order.payments.map((payment) =>
      AdminOrderPaymentDto.fromEntity(payment),
    );
    dto.itemCount = items.reduce((total, item) => total + item.quantity, 0);
    dto.lineCount = items.length;
    dto.createdAt = order.createdAt;
    dto.updatedAt = order.updatedAt;
    dto.paymentMethod = order.paymentMethod ?? null;
    return dto;
  }
}
