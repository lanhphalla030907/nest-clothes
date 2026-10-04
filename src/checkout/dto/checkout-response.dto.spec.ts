import { Prisma } from '../../generated/prisma/client.js';
import type { OrderWithItems } from '../../orders/repositories/order.repository.js';
import { OrderResponseDto } from '../../orders/dto/order-response.dto.js';
import { CheckoutResponseDto } from './checkout-response.dto.js';

const USER_ID = 'a1b2c3d4-e5f6-4f70-8a9b-0c1d2e3f4a5b';
const ORDER_ID = 'c3d4e5f6-a7b8-4c92-8d1e-2f3a4b5c6d7e';
const VARIANT_ID = 'e5f6a7b8-c9d0-4eb4-af30-4b5c6d7e8f90';

const buildOrder = (overrides: Record<string, unknown> = {}): OrderWithItems =>
  ({
    id: ORDER_ID,
    userId: USER_ID,
    orderNumber: 'ORD-20260104-AAAAAA',
    status: 'PENDING',
    subtotal: new Prisma.Decimal('258.00'),
    shippingFee: new Prisma.Decimal('0'),
    discountAmount: new Prisma.Decimal('0'),
    totalAmount: new Prisma.Decimal('258.00'),
    currency: 'USD',
    shippingRecipientName: 'Ada Lovelace',
    shippingPhone: '+15555550100',
    shippingAddressLine1: '18 Mill Lane',
    shippingAddressLine2: null,
    shippingCity: 'Bristol',
    shippingStateProvince: null,
    shippingPostalCode: 'BS1 4TR',
    shippingCountryCode: 'GB',
    createdAt: new Date('2026-01-04T11:30:00.000Z'),
    updatedAt: new Date('2026-01-04T11:30:00.000Z'),
    items: [
      {
        id: 'a7b8c9d0-e1f2-4a3b-8c4d-5e6f7a8b9c0d',
        orderId: ORDER_ID,
        variantId: VARIANT_ID,
        productName: 'Wool Peacoat',
        sku: 'COAT-NAVY-M',
        variantOptionsSnapshot: [
          { optionName: 'Color', optionValue: 'Navy' },
          { optionName: 'Size', optionValue: 'M' },
        ],
        unitPrice: new Prisma.Decimal('129.00'),
        quantity: 2,
        lineTotal: new Prisma.Decimal('258.00'),
        createdAt: new Date('2026-01-04T11:30:00.000Z'),
      },
    ],
    ...overrides,
  }) as unknown as OrderWithItems;

/**
 * The checkout receipt.
 *
 * The receipt is a named type of its own but deliberately has **no fields of its
 * own** — it delegates to `OrderResponseDto` rather than repeating that mapping.
 * These tests exist to keep that honest: if someone "improves" it by adding a key or
 * by hand-copying the mapping, the receipt and a later `GET /orders/:id` of the same
 * order stop being identical, and a client that diffs them starts seeing phantom
 * changes.
 */
describe('CheckoutResponseDto', () => {
  it('is an order response, with exactly the same keys', () => {
    const receipt = CheckoutResponseDto.fromOrder(buildOrder());
    const order = OrderResponseDto.fromEntity(buildOrder());

    expect(Object.keys(receipt).sort()).toEqual(Object.keys(order).sort());
  });

  it('produces the identical payload a later order read would', () => {
    const receipt = CheckoutResponseDto.fromOrder(buildOrder());
    const order = OrderResponseDto.fromEntity(buildOrder());

    expect(JSON.stringify(receipt)).toBe(JSON.stringify(order));
  });

  it('carries every figure a receipt needs', () => {
    const receipt = CheckoutResponseDto.fromOrder(buildOrder());

    expect(receipt).toMatchObject({
      id: ORDER_ID,
      orderNumber: 'ORD-20260104-AAAAAA',
      status: 'PENDING',
      currency: 'USD',
      subtotal: '258.00',
      shippingFee: '0.00',
      discountAmount: '0.00',
      totalAmount: '258.00',
      itemCount: 2,
      shippingRecipientName: 'Ada Lovelace',
      shippingAddressLine1: '18 Mill Lane',
      shippingCity: 'Bristol',
      shippingCountryCode: 'GB',
    });
  });

  it('renders money as fixed two-decimal strings, including the zeros', () => {
    // Shipping and discount are zero on every order this phase places. They are
    // still reported as "0.00" rather than omitted or blank, because a client
    // summing the receipt must not have to special-case them.
    const receipt = CheckoutResponseDto.fromOrder(buildOrder());

    for (const amount of [
      receipt.subtotal,
      receipt.shippingFee,
      receipt.discountAmount,
      receipt.totalAmount,
      receipt.items[0].unitPrice,
      receipt.items[0].lineTotal,
    ]) {
      expect(typeof amount).toBe('string');
      expect(amount).toMatch(/^-?\d+\.\d{2}$/);
    }
    expect(receipt.shippingFee).toBe('0.00');
    expect(receipt.discountAmount).toBe('0.00');
  });

  it('carries the address as it was at checkout', () => {
    const receipt = CheckoutResponseDto.fromOrder(
      buildOrder({
        shippingRecipientName: 'Grace Hopper',
        shippingPhone: '+15555550199',
        shippingAddressLine1: '1 Compiler Way',
        shippingCity: 'Arlington',
        shippingCountryCode: 'US',
      }),
    );

    expect(receipt.shippingRecipientName).toBe('Grace Hopper');
    expect(receipt.shippingPhone).toBe('+15555550199');
    expect(receipt.shippingAddressLine1).toBe('1 Compiler Way');
    expect(receipt.shippingCity).toBe('Arlington');
    expect(receipt.shippingCountryCode).toBe('US');
  });

  it('drops a joined user relation and its password hash', () => {
    const receipt = CheckoutResponseDto.fromOrder(
      buildOrder({
        user: {
          id: USER_ID,
          email: 'ada@example.test',
          passwordHash: 'argon2-secret',
        },
      }),
    );

    const serialised = JSON.stringify(receipt);
    expect(serialised).not.toContain('argon2-secret');
    expect(serialised).not.toContain('ada@example.test');
    expect(Object.keys(receipt)).not.toContain('user');
  });

  it('drops an inventory relation, reservedQuantity included', () => {
    const receipt = CheckoutResponseDto.fromOrder(
      buildOrder({
        inventory: { variantId: VARIANT_ID, quantity: 10, reservedQuantity: 2 },
      }),
    );

    const serialised = JSON.stringify(receipt);
    expect(serialised).not.toContain('reservedQuantity');
    expect(Object.keys(receipt)).not.toContain('inventory');
  });

  it('renders each line from its own snapshot, with no live catalogue join', () => {
    const receipt = CheckoutResponseDto.fromOrder(
      buildOrder({
        items: [
          {
            id: 'a7b8c9d0-e1f2-4a3b-8c4d-5e6f7a8b9c0d',
            orderId: ORDER_ID,
            variantId: VARIANT_ID,
            productName: 'Wool Peacoat',
            sku: 'COAT-NAVY-M',
            variantOptionsSnapshot: [{ optionName: 'Color', optionValue: 'Navy' }],
            unitPrice: new Prisma.Decimal('129.00'),
            quantity: 2,
            lineTotal: new Prisma.Decimal('258.00'),
            createdAt: new Date('2026-01-04T11:30:00.000Z'),
            variant: { product: { name: 'Renamed Product' }, price: '349.00' },
          },
        ],
      }),
    );

    expect(receipt.items[0].productName).toBe('Wool Peacoat');
    expect(receipt.items[0].sku).toBe('COAT-NAVY-M');
    expect(receipt.items[0].unitPrice).toBe('129.00');
    expect(receipt.items[0].lineTotal).toBe('258.00');
    expect(receipt.items[0]).not.toHaveProperty('variant');
  });

  it('counts units, not lines', () => {
    const receipt = CheckoutResponseDto.fromOrder(buildOrder());

    expect(receipt.itemCount).toBe(2);
    expect(receipt.items).toHaveLength(1);
  });

  it('handles an order with no lines without failing', () => {
    const receipt = CheckoutResponseDto.fromOrder(buildOrder({ items: [] }));

    expect(receipt.itemCount).toBe(0);
    expect(receipt.items).toEqual([]);
  });

  it('offers no mutation affordance on a receipt', () => {
    const receipt = CheckoutResponseDto.fromOrder(buildOrder());

    for (const key of ['actions', 'links', 'canCancel', 'canPay', 'next']) {
      expect(Object.keys(receipt)).not.toContain(key);
    }
  });

  it('has no tax field, because tax is not modelled yet', () => {
    const receipt = CheckoutResponseDto.fromOrder(buildOrder());

    expect(
      Object.keys(receipt).some((key) => key.toLowerCase().includes('tax')),
    ).toBe(false);
  });
});
