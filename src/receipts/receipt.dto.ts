import { toMoneyString } from '../common/utils/money.js';
import type { OrderStatus } from '../orders/constants/order-status.constants.js';
import type { PaymentStatus } from '../payments/constants/payment-status.constants.js';
import type { ShippingLocationSnapshotEntry } from '../orders/dto/shipping-location-snapshot.dto.js';

/** One line on the receipt, sourced entirely from the order's stored snapshot. */
export interface ReceiptLine {
  productName: string;
  sku: string;
  variantOptions: string;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
}

/** The COD collection authority for the receipt. */
export interface ReceiptCodCollection {
  status: 'COLLECTED' | 'NOT_COLLECTED';
  amount: string | null;
  currency: string | null;
  collectedAt: string | null;
  collector: { firstName: string; lastName: string } | null;
}

/** The payment authority for the receipt, distinct from COD collection. */
export interface ReceiptPayment {
  paymentMethod: string | null;
  status: 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED' | 'NONE';
  amount: string | null;
  currency: string | null;
  paidAt: string | null;
}

/** All data needed to render one receipt, sourced only from database records. */
export interface ReceiptOrderData {
  orderId: string;
  orderNumber: string;
  orderStatus: OrderStatus;
  createdAt: string;
  currency: string;
  customer: {
    firstName: string;
    lastName: string;
    email: string;
  };
  shipping: {
    recipientName: string;
    phone: string;
    addressLine1: string;
    addressLine2: string | null;
    city: string | null;
    stateProvince: string | null;
    postalCode: string | null;
    countryCode: string;
    locationPath: ShippingLocationSnapshotEntry[] | null;
  };
  financial: {
    subtotal: string;
    shippingFee: string;
    discountAmount: string;
    totalAmount: string;
  };
  items: ReceiptLine[];
  itemCount: number;
  payment: ReceiptPayment;
  codCollection: ReceiptCodCollection | null;
}

/**
 * Determines the receipt payment status from an order's payment method and its
 * payment attempts.
 *
 * The payment status is the most recent attempt's status. `PAID` is authoritative:
 * a late callback can promote `FAILED`/`EXPIRED` to `PAID`, which is why the
 * newest attempt is always the one shown.
 *
 * COD orders normally have no `payments` rows at all; their collection authority
 * is `cod_collections`, handled separately in {@link ReceiptOrderData.codCollection}.
 */
export function mapPaymentStatus(
  paymentMethod: string | null,
  attempts: Array<{ status: PaymentStatus; amount: unknown; currency: string; paidAt: Date | null }>,
): ReceiptPayment {
  const latest = attempts.length > 0 ? attempts[0] : null;

  return {
    paymentMethod,
    status: latest === null ? 'NONE' : (latest.status as ReceiptPayment['status']),
    amount: latest === null ? null : formatDecimalAmount(latest.amount),
    currency: latest === null ? null : latest.currency,
    paidAt: latest === null || latest.paidAt === null ? null : latest.paidAt.toISOString(),
  };
}

/** Formats a Decimal or string amount as a fixed two-decimal string. */
function formatDecimalAmount(value: unknown): string {
  return toMoneyString(value);
}
