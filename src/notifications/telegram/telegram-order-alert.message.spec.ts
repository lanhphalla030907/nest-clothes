import { describe, expect, it } from 'vitest';
import {
  escapeTelegramAttribute,
  escapeTelegramHtml,
  renderTelegramOrderAlert,
  type TelegramOrderAlertPayload,
} from './telegram-order-alert.message.js';

const basePayload = (
  overrides: Partial<TelegramOrderAlertPayload> = {},
): TelegramOrderAlertPayload => ({
  orderId: 'order-1',
  orderNumber: 'ORD-20261112-ABC123',
  customerName: 'Ada Lovelace',
  itemCount: 2,
  subtotal: '40.00',
  shippingFee: '5.00',
  discount: '3.00',
  total: '42.00',
  currency: 'USD',
  paymentMethod: 'COD',
  paymentStatus: 'PENDING',
  orderDate: '2026-11-12T10:00:00.000Z',
  orderStatus: 'PENDING',
  items: [
    {
      productName: 'Wool Coat',
      variantDetails: 'Color: Navy, Size: M',
      quantity: 1,
      unitPrice: '25.00',
    },
    {
      productName: 'Cotton Tee',
      variantDetails: null,
      quantity: 1,
      unitPrice: '15.00',
    },
  ],
  ...overrides,
});

describe('telegram order alert message', () => {
  it('escapes HTML special characters in dynamic content', () => {
    expect(escapeTelegramHtml('<b>&"')).toBe('&lt;b&gt;&amp;"');
    expect(escapeTelegramAttribute('a"b&<')).toBe('a&quot;b&amp;&lt;');
  });

  it('renders COD order details, payment status, items and variant details with escaping', () => {
    const text = renderTelegramOrderAlert(
      basePayload({
        customerName: 'A&B <script>',
        items: [
          {
            productName: 'Coat <XL>',
            variantDetails: 'Color: Red & Blue',
            quantity: 2,
            unitPrice: '10.00',
          },
        ],
      }),
      null,
    );

    expect(text).toContain('New order received');
    expect(text).toContain('#ORD-20261112-ABC123');
    expect(text).toContain('A&amp;B &lt;script&gt;');
    expect(text).toContain('Subtotal:</b> 40.00 USD');
    expect(text).toContain('Shipping fee:</b> 5.00 USD');
    expect(text).toContain('Discount:</b> 3.00 USD');
    expect(text).toContain('Total:</b> 42.00 USD');
    expect(text).toContain('Payment method:</b> Cash on delivery');
    expect(text).toContain('Payment status:</b> Pending');
    expect(text).toContain('Order status:</b> Pending');
    expect(text).toContain('Coat &lt;XL&gt; (Color: Red &amp; Blue) x2 @ 10.00 USD');
    expect(text).not.toContain('<script>');
  });

  it('renders PayWay order notification details', () => {
    const text = renderTelegramOrderAlert(
      basePayload({
        paymentMethod: 'PAYWAY',
        paymentStatus: 'PAID',
        orderStatus: 'CONFIRMED',
      }),
      null,
    );
    expect(text).toContain('Payment method:</b> PayWay');
    expect(text).toContain('Payment status:</b> Paid');
    expect(text).toContain('Order status:</b> Confirmed');
  });

  it('includes escaped admin dashboard link when provided', () => {
    const text = renderTelegramOrderAlert(
      basePayload(),
      'https://admin.example.com/orders/1?a=1&b="x"',
    );
    expect(text).toContain('Open in Admin Dashboard');
    expect(text).toContain(
      'https://admin.example.com/orders/1?a=1&amp;b=&quot;x&quot;',
    );
  });
});
