export interface TelegramOrderAlertItemPayload {
  productName: string;
  variantDetails: string | null;
  quantity: number;
  unitPrice: string;
}

/**
 * The snapshot stored in the Telegram outbox when an order is placed.
 *
 * Everything is a primitive so the row survives independently of later catalogue
 * or profile edits, and so a retry renders the same message the first attempt
 * would have. Amounts are pre-formatted strings; no float arithmetic happens in
 * the notifier.
 */
export interface TelegramOrderAlertPayload {
  orderId: string;
  orderNumber: string;
  customerName: string;
  itemCount: number;
  subtotal: string;
  shippingFee: string;
  discount: string;
  total: string;
  currency: string;
  paymentMethod: string | null;
  paymentStatus: string | null;
  orderDate: string;
  orderStatus: string;
  items: TelegramOrderAlertItemPayload[];
}

const formatAmount = (amount: string, currency: string): string =>
  `${escapeTelegramHtml(amount)} ${escapeTelegramHtml(currency)}`;

const formatPaymentMethod = (method: string | null): string => {
  if (method === null || method.trim() === '') return 'Not selected';

  const labels: Record<string, string> = {
    COD: 'Cash on delivery',
    PAYWAY: 'PayWay',
    ABA_PAYWAY: 'PayWay',
  };

  return escapeTelegramHtml(labels[method] ?? method);
};

const formatStatus = (status: string): string => {
  const labels: Record<string, string> = {
    PENDING: 'Pending',
    CONFIRMED: 'Confirmed',
    PROCESSING: 'Processing',
    SHIPPED: 'Shipped',
    DELIVERED: 'Delivered',
    CANCELLED: 'Cancelled',
  };

  return escapeTelegramHtml(labels[status] ?? status);
};

const formatPaymentStatus = (status: string | null): string => {
  if (status === null || status.trim() === '') return 'Unknown';

  const labels: Record<string, string> = {
    PENDING: 'Pending',
    PAID: 'Paid',
    FAILED: 'Failed',
    EXPIRED: 'Expired',
    CANCELLED: 'Cancelled',
    CANCELED: 'Cancelled',
  };

  return escapeTelegramHtml(labels[status] ?? status);
};

const formatOrderDate = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return escapeTelegramHtml(value);

  return `${date.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
};

/**
 * Escapes text for Telegram's HTML parse mode.
 *
 * Telegram accepts only a small tag subset and rejects the whole message on a
 * malformed entity, so every dynamic value goes through this function.
 * `&` must be first or the entities would be escaped twice.
 */
export const escapeTelegramHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/** Attribute values additionally need quotes escaped. */
export const escapeTelegramAttribute = (value: string): string =>
  escapeTelegramHtml(value).replace(/"/g, '&quot;');

/**
 * Renders the new-order alert.
 *
 * No customer email, phone number, address, password, token, or payment
 * credential is included.
 */
export const renderTelegramOrderAlert = (
  payload: TelegramOrderAlertPayload,
  adminUrl: string | null,
): string => {
  const lines = [
    '<b>New order received</b>',
    '',
    `<b>Order:</b> <code>#${escapeTelegramHtml(payload.orderNumber)}</code>`,
    `<b>Customer:</b> ${escapeTelegramHtml(payload.customerName)}`,
    `<b>Items:</b> ${payload.itemCount}`,
    `<b>Subtotal:</b> ${formatAmount(payload.subtotal, payload.currency)}`,
    `<b>Shipping fee:</b> ${formatAmount(payload.shippingFee, payload.currency)}`,
    `<b>Discount:</b> ${formatAmount(payload.discount, payload.currency)}`,
    `<b>Total:</b> ${formatAmount(payload.total, payload.currency)}`,
    `<b>Payment method:</b> ${formatPaymentMethod(payload.paymentMethod)}`,
    `<b>Payment status:</b> ${formatPaymentStatus(payload.paymentStatus)}`,
    `<b>Order status:</b> ${formatStatus(payload.orderStatus)}`,
    `<b>Placed:</b> ${formatOrderDate(payload.orderDate)}`,
  ];

  if (payload.items.length > 0) {
    lines.push('', '<b>Products</b>');
    for (const item of payload.items) {
      const detail =
        item.variantDetails && item.variantDetails.trim().length > 0
          ? ` (${escapeTelegramHtml(item.variantDetails)})`
          : '';
      lines.push(
        `• ${escapeTelegramHtml(item.productName)}${detail} x${item.quantity} @ ${formatAmount(item.unitPrice, payload.currency)}`,
      );
    }
  }

  if (adminUrl !== null) {
    lines.push(
      '',
      `<a href="${escapeTelegramAttribute(adminUrl)}">Open in Admin Dashboard</a>`,
    );
  }

  return lines.join('\n');
};
