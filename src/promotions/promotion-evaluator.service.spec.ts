import { Prisma, type Promotion } from '../generated/prisma/client.js';
import { InvalidMoneyValueError } from '../orders/utils/order-money.js';
import {
  DISCOUNT_TYPE,
  PROMOTION_KIND,
} from './constants/promotion.constants.js';
import { PromotionEvaluatorService } from './promotion-evaluator.service.js';
import { PromotionsRepository } from './repositories/promotions.repository.js';

const NOW = new Date('2026-11-06T12:00:00.000Z');

const promotion = (overrides: Partial<Promotion> = {}): Promotion => ({
  id: 'promotion-1',
  code: null,
  name: 'Promotion',
  description: null,
  kind: PROMOTION_KIND.AUTOMATIC,
  discountType: DISCOUNT_TYPE.PERCENTAGE,
  percentOff: new Prisma.Decimal('10.00'),
  amountOff: null,
  minSubtotal: new Prisma.Decimal('0.00'),
  maxDiscount: null,
  startsAt: null,
  endsAt: null,
  isActive: true,
  usageLimitTotal: null,
  usageLimitPerUser: null,
  priority: 0,
  archivedAt: null,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  updatedAt: new Date('2026-10-01T00:00:00.000Z'),
  ...overrides,
});

const percentage = (
  id: string,
  value: string,
  overrides: Partial<Promotion> = {},
): Promotion =>
  promotion({
    id,
    name: `${value}% promotion`,
    kind: PROMOTION_KIND.AUTOMATIC,
    discountType: DISCOUNT_TYPE.PERCENTAGE,
    percentOff: new Prisma.Decimal(value),
    ...overrides,
  });

const fixed = (
  id: string,
  value: string,
  overrides: Partial<Promotion> = {},
): Promotion =>
  promotion({
    id,
    name: `${value} off`,
    kind: PROMOTION_KIND.AUTOMATIC,
    discountType: DISCOUNT_TYPE.FIXED_AMOUNT,
    percentOff: null,
    amountOff: new Prisma.Decimal(value),
    ...overrides,
  });

const freeShipping = (
  id: string,
  overrides: Partial<Promotion> = {},
): Promotion =>
  promotion({
    id,
    name: 'Free shipping',
    kind: PROMOTION_KIND.AUTOMATIC,
    discountType: DISCOUNT_TYPE.FREE_SHIPPING,
    percentOff: null,
    amountOff: null,
    ...overrides,
  });

const coupon = (overrides: Partial<Promotion> = {}): Promotion =>
  promotion({
    ...overrides,
    kind: PROMOTION_KIND.COUPON,
    code: overrides.code ?? 'SAVE10',
  });

const money = (value: Prisma.Decimal | string): string =>
  value instanceof Prisma.Decimal ? value.toFixed(2) : value;

type RepositoryMock = {
  findByCode: ReturnType<typeof vi.fn>;
  findAutomaticCandidates: ReturnType<typeof vi.fn>;
  countUsages: ReturnType<typeof vi.fn>;
  countUsagesForUser: ReturnType<typeof vi.fn>;
};

describe('PromotionEvaluatorService', () => {
  let repository: RepositoryMock;
  let service: PromotionEvaluatorService;

  beforeEach(() => {
    repository = {
      findByCode: vi.fn().mockResolvedValue(null),
      findAutomaticCandidates: vi.fn().mockResolvedValue([]),
      countUsages: vi.fn().mockResolvedValue(0),
      countUsagesForUser: vi.fn().mockResolvedValue(0),
    };
    service = new PromotionEvaluatorService(
      repository as unknown as PromotionsRepository,
    );
  });

  const evaluate = (
    overrides: Partial<
      Parameters<PromotionEvaluatorService['evaluate']>[0]
    > = {},
  ) =>
    service.evaluate({
      userId: 'user-1',
      subtotal: '100.00',
      shippingFee: '5.00',
      now: NOW,
      ...overrides,
    });

  describe('discount arithmetic', () => {
    it('rounds a percentage discount half-up to two decimals', async () => {
      repository.findByCode.mockResolvedValue(
        coupon({
          discountType: DISCOUNT_TYPE.PERCENTAGE,
          percentOff: new Prisma.Decimal('10.00'),
        }),
      );

      const result = await evaluate({
        subtotal: '10.05',
        shippingFee: '0.00',
        couponCode: 'save10',
      });

      expect(result.coupon?.discountAmount).toBe('1.01');
      expect(money(result.discountAmount)).toBe('1.01');
      expect(money(result.totalAmount)).toBe('9.04');
      expect(repository.findByCode).toHaveBeenCalledWith('SAVE10', undefined);
    });

    it('keeps exact decimal precision for a percentage that lands on a half cent', async () => {
      repository.findAutomaticCandidates.mockResolvedValue([
        percentage('p1', '15.00'),
      ]);

      const result = await evaluate({ subtotal: '33.33', shippingFee: '0.00' });

      expect(result.automatic?.discountAmount).toBe('5.00');
      expect(money(result.totalAmount)).toBe('28.33');
    });

    it('subtracts a fixed amount from the product subtotal', async () => {
      repository.findAutomaticCandidates.mockResolvedValue([
        fixed('p1', '10.00'),
      ]);

      const result = await evaluate({ subtotal: '25.00', shippingFee: '4.00' });

      expect(result.automatic?.discountAmount).toBe('10.00');
      expect(money(result.totalAmount)).toBe('19.00');
    });

    it('never lets a fixed discount exceed the product subtotal', async () => {
      repository.findAutomaticCandidates.mockResolvedValue([
        fixed('p1', '50.00'),
      ]);

      const result = await evaluate({ subtotal: '20.00', shippingFee: '7.00' });

      expect(result.automatic?.discountAmount).toBe('20.00');
      expect(money(result.discountAmount)).toBe('20.00');
      expect(money(result.totalAmount)).toBe('7.00');
    });

    it('makes free shipping equal to the original shipping fee', async () => {
      repository.findAutomaticCandidates.mockResolvedValue([
        freeShipping('p1'),
      ]);

      const result = await evaluate({ subtotal: '20.00', shippingFee: '5.50' });

      expect(result.automatic?.discountAmount).toBe('5.50');
      expect(money(result.shippingFee)).toBe('5.50');
      expect(money(result.totalAmount)).toBe('20.00');
    });

    it('applies maxDiscount to a percentage discount', async () => {
      repository.findAutomaticCandidates.mockResolvedValue([
        percentage('p1', '50.00', {
          maxDiscount: new Prisma.Decimal('12.34'),
        }),
      ]);

      const result = await evaluate({
        subtotal: '100.00',
        shippingFee: '0.00',
      });

      expect(result.automatic?.discountAmount).toBe('12.34');
      expect(money(result.totalAmount)).toBe('87.66');
    });

    it('applies maxDiscount to a fixed discount', async () => {
      repository.findAutomaticCandidates.mockResolvedValue([
        fixed('p1', '25.00', {
          maxDiscount: new Prisma.Decimal('7.50'),
        }),
      ]);

      const result = await evaluate({
        subtotal: '100.00',
        shippingFee: '0.00',
      });

      expect(result.automatic?.discountAmount).toBe('7.50');
    });

    it('applies maxDiscount to free shipping', async () => {
      repository.findAutomaticCandidates.mockResolvedValue([
        freeShipping('p1', {
          maxDiscount: new Prisma.Decimal('2.00'),
        }),
      ]);

      const result = await evaluate({ subtotal: '20.00', shippingFee: '5.00' });

      expect(result.automatic?.discountAmount).toBe('2.00');
      expect(money(result.totalAmount)).toBe('23.00');
    });
  });

  describe('eligibility window and state', () => {
    it('applies at the minimum subtotal boundary', async () => {
      repository.findAutomaticCandidates.mockResolvedValue([
        percentage('p1', '10.00', {
          minSubtotal: new Prisma.Decimal('50.00'),
        }),
      ]);

      const result = await evaluate({ subtotal: '50.00', shippingFee: '0.00' });

      expect(result.automatic).not.toBeNull();
      expect(result.automatic?.discountAmount).toBe('5.00');
    });

    it('does not apply below the minimum subtotal boundary', async () => {
      repository.findAutomaticCandidates.mockResolvedValue([
        percentage('p1', '10.00', {
          minSubtotal: new Prisma.Decimal('50.00'),
        }),
      ]);

      const result = await evaluate({ subtotal: '49.99', shippingFee: '0.00' });

      expect(result.automatic).toBeNull();
      expect(money(result.discountAmount)).toBe('0.00');
    });

    it('treats startsAt as inclusive', async () => {
      repository.findAutomaticCandidates.mockResolvedValue([
        percentage('p1', '10.00', { startsAt: NOW }),
      ]);

      const result = await evaluate({ subtotal: '100.00' });

      expect(result.automatic).not.toBeNull();
    });

    it('treats endsAt as inclusive', async () => {
      repository.findAutomaticCandidates.mockResolvedValue([
        percentage('p1', '10.00', { endsAt: NOW }),
      ]);

      const result = await evaluate({ subtotal: '100.00' });

      expect(result.automatic).not.toBeNull();
    });

    it('does not apply before startsAt', async () => {
      repository.findAutomaticCandidates.mockResolvedValue([
        percentage('p1', '10.00', {
          startsAt: new Date(NOW.getTime() + 1),
        }),
      ]);

      const result = await evaluate({ subtotal: '100.00' });

      expect(result.automatic).toBeNull();
    });

    it('does not apply after endsAt', async () => {
      repository.findAutomaticCandidates.mockResolvedValue([
        percentage('p1', '10.00', {
          endsAt: new Date(NOW.getTime() - 1),
        }),
      ]);

      const result = await evaluate({ subtotal: '100.00' });

      expect(result.automatic).toBeNull();
    });

    it('does not apply a paused promotion', async () => {
      repository.findAutomaticCandidates.mockResolvedValue([
        percentage('p1', '10.00', { isActive: false }),
      ]);

      const result = await evaluate({ subtotal: '100.00' });

      expect(result.automatic).toBeNull();
    });

    it('does not apply an archived promotion', async () => {
      repository.findAutomaticCandidates.mockResolvedValue([
        percentage('p1', '10.00', { archivedAt: NOW }),
      ]);

      const result = await evaluate({ subtotal: '100.00' });

      expect(result.automatic).toBeNull();
    });
  });

  describe('usage limits', () => {
    it('applies below the global usage limit', async () => {
      repository.findAutomaticCandidates.mockResolvedValue([
        percentage('p1', '10.00', { usageLimitTotal: 2 }),
      ]);
      repository.countUsages.mockResolvedValue(1);

      const result = await evaluate({ subtotal: '100.00' });

      expect(result.automatic).not.toBeNull();
      expect(repository.countUsages).toHaveBeenCalledWith('p1', undefined);
    });

    it('rejects at the global usage limit', async () => {
      repository.findAutomaticCandidates.mockResolvedValue([
        percentage('p1', '10.00', { usageLimitTotal: 2 }),
      ]);
      repository.countUsages.mockResolvedValue(2);

      const result = await evaluate({ subtotal: '100.00' });

      expect(result.automatic).toBeNull();
    });

    it('applies below the per-user usage limit', async () => {
      repository.findAutomaticCandidates.mockResolvedValue([
        percentage('p1', '10.00', { usageLimitPerUser: 1 }),
      ]);
      repository.countUsagesForUser.mockResolvedValue(0);

      const result = await evaluate({ userId: 'user-7', subtotal: '100.00' });

      expect(result.automatic).not.toBeNull();
      expect(repository.countUsagesForUser).toHaveBeenCalledWith(
        'p1',
        'user-7',
        undefined,
      );
    });

    it('rejects at the per-user usage limit', async () => {
      repository.findAutomaticCandidates.mockResolvedValue([
        percentage('p1', '10.00', { usageLimitPerUser: 1 }),
      ]);
      repository.countUsagesForUser.mockResolvedValue(1);

      const result = await evaluate({ subtotal: '100.00' });

      expect(result.automatic).toBeNull();
    });

    it('treats a zero usage limit as no allowed uses', async () => {
      repository.findAutomaticCandidates.mockResolvedValue([
        percentage('p1', '10.00', { usageLimitTotal: 0 }),
      ]);

      const result = await evaluate({ subtotal: '100.00' });

      expect(result.automatic).toBeNull();
    });
  });

  describe('stacking and automatic selection', () => {
    it('selects the highest-discount automatic promotion', async () => {
      repository.findAutomaticCandidates.mockResolvedValue([
        percentage('p1', '10.00'),
        percentage('p2', '25.00'),
        percentage('p3', '15.00'),
      ]);

      const result = await evaluate({
        subtotal: '100.00',
        shippingFee: '0.00',
      });

      expect(result.automatic?.promotionId).toBe('p2');
      expect(result.automatic?.discountAmount).toBe('25.00');
    });

    it('breaks an equal-discount tie by priority descending', async () => {
      repository.findAutomaticCandidates.mockResolvedValue([
        percentage('low', '10.00', { priority: 1 }),
        percentage('high', '10.00', { priority: 9 }),
      ]);

      const result = await evaluate({
        subtotal: '100.00',
        shippingFee: '0.00',
      });

      expect(result.automatic?.promotionId).toBe('high');
    });

    it('does not stack multiple automatic promotions', async () => {
      repository.findAutomaticCandidates.mockResolvedValue([
        percentage('p1', '10.00'),
        fixed('p2', '12.00'),
        freeShipping('p3'),
      ]);

      const result = await evaluate({
        subtotal: '100.00',
        shippingFee: '5.00',
      });

      expect(result.appliedPromotions).toHaveLength(1);
      expect(result.automatic?.promotionId).toBe('p2');
      expect(money(result.discountAmount)).toBe('12.00');
    });

    it('stacks one coupon with one automatic promotion', async () => {
      repository.findByCode.mockResolvedValue(
        coupon({
          discountType: DISCOUNT_TYPE.PERCENTAGE,
          percentOff: new Prisma.Decimal('10.00'),
        }),
      );
      repository.findAutomaticCandidates.mockResolvedValue([
        percentage('auto-1', '5.00'),
      ]);

      const result = await evaluate({
        subtotal: '100.00',
        shippingFee: '0.00',
        couponCode: 'SAVE10',
      });

      expect(result.coupon?.promotionId).toBe('promotion-1');
      expect(result.automatic?.promotionId).toBe('auto-1');
      expect(result.appliedPromotions.map((item) => item.promotionId)).toEqual([
        'promotion-1',
        'auto-1',
      ]);
      expect(money(result.discountAmount)).toBe('15.00');
      expect(money(result.totalAmount)).toBe('85.00');
    });

    it('still applies an automatic promotion when the coupon is unknown', async () => {
      repository.findByCode.mockResolvedValue(null);
      repository.findAutomaticCandidates.mockResolvedValue([
        percentage('auto-1', '10.00'),
      ]);

      const result = await evaluate({
        subtotal: '100.00',
        shippingFee: '0.00',
        couponCode: 'NOPE',
      });

      expect(result.coupon).toBeNull();
      expect(result.automatic?.promotionId).toBe('auto-1');
    });
  });

  describe('non-negative totals and input precision', () => {
    it('caps the combined discount so the order total cannot be negative', async () => {
      repository.findByCode.mockResolvedValue(
        coupon({
          discountType: DISCOUNT_TYPE.FIXED_AMOUNT,
          percentOff: null,
          amountOff: new Prisma.Decimal('100.00'),
        }),
      );
      repository.findAutomaticCandidates.mockResolvedValue([
        fixed('auto-1', '100.00'),
      ]);

      const result = await evaluate({
        subtotal: '30.00',
        shippingFee: '5.00',
        couponCode: 'SAVE10',
      });

      expect(money(result.discountAmount)).toBe('35.00');
      expect(money(result.totalAmount)).toBe('0.00');
      expect(result.coupon?.discountAmount).toBe('30.00');
      expect(result.automatic?.discountAmount).toBe('5.00');
      expect(
        money(
          new Prisma.Decimal(result.coupon?.discountAmount ?? '0').plus(
            new Prisma.Decimal(result.automatic?.discountAmount ?? '0'),
          ),
        ),
      ).toBe('35.00');
    });

    it('drops a promotion reduced to zero by the total cap', async () => {
      repository.findByCode.mockResolvedValue(
        coupon({
          discountType: DISCOUNT_TYPE.FIXED_AMOUNT,
          percentOff: null,
          amountOff: new Prisma.Decimal('30.00'),
        }),
      );
      repository.findAutomaticCandidates.mockResolvedValue([
        fixed('auto-1', '5.00'),
      ]);

      const result = await evaluate({
        subtotal: '30.00',
        shippingFee: '0.00',
        couponCode: 'SAVE10',
      });

      expect(money(result.discountAmount)).toBe('30.00');
      expect(money(result.totalAmount)).toBe('0.00');
      expect(result.automatic).toBeNull();
      expect(result.appliedPromotions).toHaveLength(1);
    });

    it('returns a zero discount when nothing qualifies', async () => {
      const result = await evaluate({
        subtotal: '100.00',
        shippingFee: '5.00',
      });

      expect(money(result.discountAmount)).toBe('0.00');
      expect(money(result.totalAmount)).toBe('105.00');
      expect(result.appliedPromotions).toEqual([]);
    });

    it('rounds input money to the two-decimal order scale', async () => {
      repository.findAutomaticCandidates.mockResolvedValue([
        percentage('p1', '10.00'),
      ]);

      const result = await evaluate({
        subtotal: '10.005',
        shippingFee: '0.005',
      });

      expect(money(result.subtotal)).toBe('10.01');
      expect(money(result.shippingFee)).toBe('0.01');
      expect(money(result.discountAmount)).toBe('1.00');
    });

    it('rejects a negative subtotal', async () => {
      await expect(
        evaluate({ subtotal: '-1.00', shippingFee: '0.00' }),
      ).rejects.toBeInstanceOf(InvalidMoneyValueError);
    });

    it('rejects a negative shipping fee', async () => {
      await expect(
        evaluate({ subtotal: '10.00', shippingFee: '-0.01' }),
      ).rejects.toBeInstanceOf(InvalidMoneyValueError);
    });
  });

  describe('transaction compatibility', () => {
    it('forwards the caller transaction client to every read', async () => {
      const tx = {
        marker: 'transaction',
      } as unknown as Prisma.TransactionClient;
      repository.findByCode.mockResolvedValue(
        coupon({ usageLimitTotal: 2, usageLimitPerUser: 2 }),
      );
      repository.findAutomaticCandidates.mockResolvedValue([
        percentage('auto-1', '10.00', {
          usageLimitTotal: 2,
          usageLimitPerUser: 2,
        }),
      ]);

      await service.evaluate(
        {
          userId: 'user-1',
          subtotal: '100.00',
          shippingFee: '5.00',
          couponCode: 'SAVE10',
          now: NOW,
        },
        tx,
      );

      expect(repository.findByCode).toHaveBeenCalledWith('SAVE10', tx);
      expect(repository.findAutomaticCandidates).toHaveBeenCalledWith(
        '100.00',
        NOW,
        tx,
      );
      expect(repository.countUsages).toHaveBeenCalledWith('promotion-1', tx);
      expect(repository.countUsagesForUser).toHaveBeenCalledWith(
        'promotion-1',
        'user-1',
        tx,
      );
      expect(repository.countUsages).toHaveBeenCalledWith('auto-1', tx);
      expect(repository.countUsagesForUser).toHaveBeenCalledWith(
        'auto-1',
        'user-1',
        tx,
      );
    });
  });
});
