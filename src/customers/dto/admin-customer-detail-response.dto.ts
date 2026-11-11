import { Prisma } from '../../generated/prisma/client.js';
import { toMoneyString } from '../../common/utils/money.js';
import type {
  AdminCustomerRow,
  CustomerAddressRow,
  CustomerRecentOrderRow,
} from '../customers.repository.js';
import type { AdminCustomerMoneyDto } from './admin-customer-money.dto.js';

/** One of a customer's recent orders, enough to recognise and route to it. */
export class AdminCustomerRecentOrderDto {
  id: string;
  orderNumber: string;
  status: string;
  paymentMethod: string | null;
  totalAmount: string;
  currency: string;
  /** Total units across the order's lines. */
  itemCount: number;
  createdAt: Date;
  /**
   * Whether money moved for this order: some payment attempt reached `PAID`,
   * or cash was collected for a COD order. An unpaid pending order and a
   * cancelled order with no collection are both `false`.
   */
  isPaid: boolean;

  static fromRow(order: CustomerRecentOrderRow): AdminCustomerRecentOrderDto {
    const dto = new AdminCustomerRecentOrderDto();

    dto.id = order.id;
    dto.orderNumber = order.orderNumber;
    dto.status = order.status;
    dto.paymentMethod = order.paymentMethod;
    dto.totalAmount = toMoneyString(order.totalAmount);
    dto.currency = order.currency;
    dto.itemCount = order.items.reduce(
      (total, item) => total + item.quantity,
      0,
    );
    dto.createdAt = order.createdAt;
    dto.isPaid =
      order.payments.length > 0 || order.codCollections.length > 0;
    return dto;
  }
}

/** One saved address of a customer, as the customer's own book shows it. */
export class AdminCustomerAddressDto {
  id: string;
  label: string;
  recipientName: string;
  phone: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string | null;
  stateProvince: string | null;
  administrativeLocationPcode: string | null;
  postalCode: string | null;
  countryCode: string;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;

  static fromRow(address: CustomerAddressRow): AdminCustomerAddressDto {
    const dto = new AdminCustomerAddressDto();

    dto.id = address.id;
    dto.label = address.label;
    dto.recipientName = address.recipientName;
    dto.phone = address.phone;
    dto.addressLine1 = address.addressLine1;
    dto.addressLine2 = address.addressLine2;
    dto.city = address.city;
    dto.stateProvince = address.stateProvince;
    dto.administrativeLocationPcode = address.administrativeLocationPcode;
    dto.postalCode = address.postalCode;
    dto.countryCode = address.countryCode;
    dto.isDefault = address.isDefault;
    dto.createdAt = address.createdAt;
    dto.updatedAt = address.updatedAt;
    return dto;
  }
}

/**
 * One customer, read-only, for the administrative detail view.
 *
 * Everything here is observation: the profile the customer registered with,
 * the contact details, the account status, the registration and sign-in
 * facts, and the order aggregates. There is deliberately no editable field
 * and no action — this feature never changes a customer.
 *
 * Money is per currency and never combined. `averageOrderValueByCurrency` is
 * the spendable spend in a currency divided by that currency's spendable order
 * count, so `amount = totalSpentByCurrency / spendingOrders` per entry; it is
 * absent for a currency with no spendable orders rather than zero, and it is
 * rounded half-up to the two-decimal money convention.
 */
export class AdminCustomerDetailResponseDto {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  emailVerifiedAt: Date | null;
  lastLoginAt: Date | null;
  /** Every order, in any status, including `CANCELLED`. */
  totalOrders: number;
  /** Orders in `CANCELLED`, a subset of `totalOrders`. */
  cancelledOrders: number;
  /** Orders that count toward spending. */
  spendingOrders: number;
  totalSpentByCurrency: AdminCustomerMoneyDto[];
  averageOrderValueByCurrency: AdminCustomerMoneyDto[];
  lastOrderAt: Date | null;
  recentOrders: AdminCustomerRecentOrderDto[];
  addresses: AdminCustomerAddressDto[];

  static fromResult(
    row: AdminCustomerRow,
    recentOrders: CustomerRecentOrderRow[],
    addresses: CustomerAddressRow[],
  ): AdminCustomerDetailResponseDto {
    const dto = new AdminCustomerDetailResponseDto();

    dto.id = row.id;
    dto.firstName = row.first_name;
    dto.lastName = row.last_name;
    dto.email = row.email;
    dto.phone = row.phone;
    dto.status = row.status;
    dto.createdAt = row.created_at;
    dto.updatedAt = row.updated_at;
    dto.emailVerifiedAt = row.email_verified_at;
    dto.lastLoginAt = row.last_login_at;
    dto.totalOrders = row.total_orders;
    dto.cancelledOrders = row.cancelled_orders;
    dto.spendingOrders = row.spending_orders;
    dto.totalSpentByCurrency = row.total_spent_by_currency.map((entry) => ({
      currency: entry.currency,
      amount: toMoneyString(entry.amount),
    }));
    dto.averageOrderValueByCurrency = row.total_spent_by_currency
      .filter((entry) => entry.orderCount > 0)
      .map((entry) => ({
        currency: entry.currency,
        amount: new Prisma.Decimal(entry.amount)
          .div(entry.orderCount)
          .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
          .toFixed(2),
      }));
    dto.lastOrderAt = row.last_order_at;
    dto.recentOrders = recentOrders.map((order) =>
      AdminCustomerRecentOrderDto.fromRow(order),
    );
    dto.addresses = addresses.map((address) =>
      AdminCustomerAddressDto.fromRow(address),
    );
    return dto;
  }
}
