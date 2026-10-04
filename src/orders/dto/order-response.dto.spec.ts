import { Prisma } from '../../generated/prisma/client.js';
import { ORDER_STATUS } from '../constants/order-status.constants.js';
import type { OrderWithItems } from '../repositories/order.repository.js';
import { OrderItemResponseDto, OrderItemVariantOptionDto } from './order-item-response.dto.js';
import { OrderResponseDto } from './order-response.dto.js';
import { OrderSummaryResponseDto } from './order-summary-response.dto.js';

const USER_ID = 'a1b2c3d4-e5f6-4f70-8a9b-0c1d2e3f4a5b';
const ORDER_ID = 'c3d4e5f6-a7b8-4c92-8d1e-2f3a4b5c6d7e';
const VARIANT_ID = 'e5f6a7b8-c9d0-4eb4-af30-4b5c6d7e8f90';
const CREATED_AT = new Date('2026-01-04T11:30:00.000Z');

const buildItem = (overrides: Record<string, unknown> = {}) => ({
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
  createdAt: CREATED_AT,
  ...overrides,
});

const buildOrder = (
  overrides: Record<string, unknown> = {},
): OrderWithItems =>
  ({
    id: ORDER_ID,
    userId: USER_ID,
    orderNumber: 'ORD-20260104-AAAAAA',
    status: 'PENDING',
    subtotal: new Prisma.Decimal('258.00'),
    shippingFee: new Prisma.Decimal('7.50'),
    discountAmount: new Prisma.Decimal('8.00'),
    totalAmount: new Prisma.Decimal('257.50'),
    currency: 'USD',
    shippingRecipientName: 'Ada Lovelace',
    shippingPhone: '+15555550100',
    shippingAddressLine1: '18 Mill Lane',
    shippingAddressLine2: null,
    shippingCity: 'Bristol',
    shippingStateProvince: null,
    shippingPostalCode: 'BS1 4TR',
    shippingCountryCode: 'GB',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    items: [buildItem()],
    ...overrides,
  }) as unknown as OrderWithItems;

/**
 * The outbound contract.
 *
 * These tests exist because the failure they guard against is invisible in review
 * and invisible at runtime: a DTO built with `{ ...order }` or `{ ...item }` would
 * pass every functional test while quietly shipping `passwordHash`, `user` and every
 * future column to the client. So the assertions are about *which keys exist*, not
 * only about the values in them.
 */
describe('order response DTOs', () => {
  describe('OrderResponseDto', () => {
    it('exposes exactly the documented keys', () => {
      const dto = OrderResponseDto.fromEntity(buildOrder());

      expect(Object.keys(dto).sort()).toEqual(
        [
          'createdAt',
          'currency',
          'discountAmount',
          'id',
          'itemCount',
          'items',
          'orderNumber',
          'shippingAddressLine1',
          'shippingAddressLine2',
          'shippingCity',
          'shippingCountryCode',
          'shippingFee',
          'shippingPhone',
          'shippingPostalCode',
          'shippingRecipientName',
          'shippingStateProvince',
          'status',
          'subtotal',
          'totalAmount',
          'updatedAt',
          'userId',
        ].sort(),
      );
    });

    it('drops any extra column on the row, including a leaked password hash', () => {
      const dto = OrderResponseDto.fromEntity(
        buildOrder({
          user: { id: USER_ID, email: 'ada@example.test', passwordHash: 'argon2' },
          addressId: '11111111-1111-4111-8111-111111111111',
        }),
      );

      // Nothing is spread, so a joined user relation cannot reach the response.
      expect(Object.keys(dto)).not.toContain('user');
      expect(Object.keys(dto)).not.toContain('addressId');
      expect(JSON.stringify(dto)).not.toContain('argon2');
      expect(JSON.stringify(dto)).not.toContain('ada@example.test');
    });

    it('renders every amount as a fixed two-decimal string', () => {
      const dto = OrderResponseDto.fromEntity(buildOrder());

      expect(dto.subtotal).toBe('258.00');
      expect(dto.shippingFee).toBe('7.50');
      expect(dto.discountAmount).toBe('8.00');
      expect(dto.totalAmount).toBe('257.50');
      for (const amount of [
        dto.subtotal,
        dto.shippingFee,
        dto.discountAmount,
        dto.totalAmount,
      ]) {
        expect(typeof amount).toBe('string');
        expect(amount).toMatch(/^-?\d+\.\d{2}$/);
      }
    });

    it('reads the stored total rather than recomputing it', () => {
      // The CHECK constraint guarantees the stored figure is the correct one;
      // recomputing here would duplicate arithmetic that is already enforced.
      const dto = OrderResponseDto.fromEntity(buildOrder());

      expect(dto.totalAmount).toBe('257.50');
    });

    it('keeps the stored status, whatever it is', () => {
      const dto = OrderResponseDto.fromEntity(buildOrder({ status: 'SHIPPED' }));

      expect(dto.status).toBe('SHIPPED');
      expect(OrderSummaryResponseDto.KNOWN_STATUSES).toContain(dto.status);
    });

    it('preserves null address fields as null, not as empty strings', () => {
      const dto = OrderResponseDto.fromEntity(buildOrder());

      expect(dto.shippingAddressLine2).toBeNull();
      expect(dto.shippingStateProvince).toBeNull();
      // Present, so it must survive: "not supplied" and "supplied" differ.
      expect(dto.shippingPostalCode).toBe('BS1 4TR');
    });

    it('counts units, not lines', () => {
      const dto = OrderResponseDto.fromEntity(
        buildOrder({
          items: [buildItem({ quantity: 2 }), buildItem({ quantity: 3 })],
        }),
      );

      expect(dto.itemCount).toBe(5);
      expect(dto.items).toHaveLength(2);
    });

    it('handles an order with no items without dividing or failing', () => {
      const dto = OrderResponseDto.fromEntity(buildOrder({ items: [] }));

      expect(dto.itemCount).toBe(0);
      expect(dto.items).toEqual([]);
    });

    it('has no tax field, because tax is not modelled yet', () => {
      const dto = OrderResponseDto.fromEntity(buildOrder());

      expect(Object.keys(dto).some((key) => key.toLowerCase().includes('tax'))).toBe(
        false,
      );
    });

    it('offers no mutation affordance to advertise a capability that does not exist', () => {
      const dto = OrderResponseDto.fromEntity(buildOrder());

      for (const key of ['links', 'actions', 'canCancel', 'canUpdate']) {
        expect(Object.keys(dto)).not.toContain(key);
      }
    });
  });

  describe('OrderSummaryResponseDto', () => {
    it('exposes exactly the documented keys, and no items or full address', () => {
      const dto = OrderSummaryResponseDto.fromEntity(buildOrder());

      expect(Object.keys(dto).sort()).toEqual(
        [
          'createdAt',
          'currency',
          'discountAmount',
          'id',
          'itemCount',
          'lineCount',
          'orderNumber',
          'shippingCity',
          'shippingCountryCode',
          'shippingFee',
          'shippingRecipientName',
          'status',
          'subtotal',
          'totalAmount',
          'updatedAt',
          'userId',
        ].sort(),
      );
    });

    it('distinguishes a bag count from a line count', () => {
      const dto = OrderSummaryResponseDto.fromEntity(
        buildOrder({
          items: [buildItem({ quantity: 2 }), buildItem({ quantity: 3 })],
        }),
      );

      expect(dto.itemCount).toBe(5);
      expect(dto.lineCount).toBe(2);
    });

    it('renders amounts as strings exactly as the detail view does', () => {
      const dto = OrderSummaryResponseDto.fromEntity(buildOrder());

      expect(dto.totalAmount).toBe('257.50');
      expect(typeof dto.totalAmount).toBe('string');
    });

    it('reconciles a stored order against its own lines, in Decimal', () => {
      expect(OrderSummaryResponseDto.reconcilesWithItems(buildOrder())).toBe(
        true,
      );
    });

    it('reports a mismatch rather than hiding it', () => {
      const tampered = buildOrder({
        subtotal: new Prisma.Decimal('999.00'),
      });

      expect(OrderSummaryResponseDto.reconcilesWithItems(tampered)).toBe(false);
    });

    it('lists every status the constants define', () => {
      expect([...OrderSummaryResponseDto.KNOWN_STATUSES].sort()).toEqual(
        Object.values(ORDER_STATUS).sort(),
      );
    });
  });

  describe('OrderItemResponseDto', () => {
    it('exposes exactly the documented keys', () => {
      const dto = OrderItemResponseDto.fromEntity(buildItem());

      expect(Object.keys(dto).sort()).toEqual(
        [
          'createdAt',
          'id',
          'lineTotal',
          'orderId',
          'productName',
          'quantity',
          'sku',
          'unitPrice',
          'variantId',
          'variantOptionsSnapshot',
        ].sort(),
      );
    });

    it('renders the snapshot money as strings', () => {
      const dto = OrderItemResponseDto.fromEntity(buildItem());

      expect(dto.unitPrice).toBe('129.00');
      expect(dto.lineTotal).toBe('258.00');
    });

    it('keeps the snapshot options in their stored order', () => {
      const dto = OrderItemResponseDto.fromEntity(buildItem());

      expect(dto.variantOptionsSnapshot).toEqual([
        { optionName: 'Color', optionValue: 'Navy' },
        { optionName: 'Size', optionValue: 'M' },
      ]);
    });

    it('returns an empty list for a variant with no options', () => {
      const dto = OrderItemResponseDto.fromEntity(
        buildItem({ variantOptionsSnapshot: [] }),
      );

      expect(dto.variantOptionsSnapshot).toEqual([]);
    });

    it('does not join the live variant to fill in a name or a price', () => {
      const dto = OrderItemResponseDto.fromEntity(
        buildItem({
          productName: 'Wool Peacoat',
          variant: { product: { name: 'Renamed Product' }, price: '349.00' },
        }),
      );

      expect(dto.productName).toBe('Wool Peacoat');
      expect(dto).not.toHaveProperty('variant');
      expect(dto.unitPrice).toBe('129.00');
    });
  });

  describe('OrderItemVariantOptionDto.fromSnapshot', () => {
    it('maps well-formed pairs', () => {
      expect(
        OrderItemVariantOptionDto.fromSnapshot([
          { optionName: 'Color', optionValue: 'Navy' },
        ]),
      ).toEqual([{ optionName: 'Color', optionValue: 'Navy' }]);
    });

    it.each([
      ['a non-array', { optionName: 'Color', optionValue: 'Navy' }],
      ['null', null],
      ['undefined', undefined],
      ['a string', 'Color=Navy'],
      ['a number', 7],
    ])('degrades %s to an empty list', (_label, snapshot) => {
      expect(OrderItemVariantOptionDto.fromSnapshot(snapshot)).toEqual([]);
    });

    it('drops malformed entries rather than emitting an unrenderable shape', () => {
      // JSONB guarantees the value is JSON, not that it matches this shape, so the
      // read is defensive and the write is what enforces it.
      expect(
        OrderItemVariantOptionDto.fromSnapshot([
          { optionName: 'Color', optionValue: 'Navy' },
          { optionName: 'Size' },
          { optionValue: 'M' },
          null,
          'Color=Black',
        ]),
      ).toEqual([{ optionName: 'Color', optionValue: 'Navy' }]);
    });
  });
});
