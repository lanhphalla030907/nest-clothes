import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { CheckoutService } from './checkout.service.js';
import { CheckoutQuotesRepository } from './repositories/checkout-quotes.repository.js';
import { CartRepository } from '../cart/repositories/cart.repository.js';
import { InventoryRepository } from '../inventory/repositories/inventory.repository.js';
import { OrderService } from '../orders/order.service.js';
import { OrderRepository } from '../orders/repositories/order.repository.js';
import { AddressesService } from '../addresses/addresses.service.js';
import { UsersRepository } from '../users/repositories/users.repository.js';
import { ShippingProvidersRepository } from '../shipping-providers/repositories/shipping-providers.repository.js';
import { CodAreasRepository } from '../cod-areas/repositories/cod-areas.repository.js';
import { AdministrativeLocationsService } from '../locations/administrative-locations.service.js';
import { PromotionEvaluatorService } from '../promotions/promotion-evaluator.service.js';
import { PromotionsRepository } from '../promotions/repositories/promotions.repository.js';

const USER_ID = 'a1b2c3d4-e5f6-4f70-8a9b-0c1d2e3f4a5b';
const ADDRESS_ID = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';
const PROVIDER_ID = 'c3d4e5f6-a7b8-4c90-8d1e-2f3a4b5c6d7e';
const AREA_ID = 'd4e5f6a7-b8c9-4d01-9e2f-3a4b5c6d7e';
const VARIANT_ID = 'e5f6a7b8-c9d0-4e12-af30-4b5c6d7e8f90';
const QUOTE_ID = 'f6a7b8c9-d0e1-4f23-b041-5c6d7e8f9012';
const IDEMPOTENCY_KEY = 'a7b8c9d0-e1f2-4034-8152-6d7e8f901234';
const txQueryRaw = vi.fn().mockResolvedValue([]);
const TX = { $queryRaw: txQueryRaw } as unknown as Prisma.TransactionClient;

const address = {
  id: ADDRESS_ID,
  userId: USER_ID,
  label: 'Home',
  recipientName: 'Ada Lovelace',
  phone: '+85512345678',
  addressLine1: '12 Street',
  addressLine2: null,
  city: null,
  stateProvince: null,
  administrativeLocationPcode: 'KH120101',
  administrativeLocationPath: [
    { pcode: 'KH12', parentPcode: null, adminLevel: 1, nameEn: 'Phnom Penh', nameKm: null },
    { pcode: 'KH1201', parentPcode: 'KH12', adminLevel: 2, nameEn: 'Chamkar Mon', nameKm: null },
    { pcode: 'KH120101', parentPcode: 'KH1201', adminLevel: 3, nameEn: 'Tonle Bassac', nameKm: null },
  ],
  postalCode: null,
  countryCode: 'KH',
  isDefault: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

const cart = {
  id: 'b3c4d5e6-f7a8-4901-8e2f-3a4b5c6d7e8f',
  userId: USER_ID,
  items: [{ variantId: VARIANT_ID, quantity: 2 }],
};

const resolvedLine = {
  variantId: VARIANT_ID,
  productName: 'Cotton Shirt',
  sku: 'SHIRT-01',
  variantOptionsSnapshot: [{ optionName: 'Size', optionValue: 'M' }],
  unitPrice: new Prisma.Decimal('12.50'),
  quantity: 2,
  lineTotal: new Prisma.Decimal('25.00'),
};

const provider = {
  id: PROVIDER_ID,
  code: 'LOCAL-DELIVERY',
  name: 'Local Delivery',
  baseFee: new Prisma.Decimal('3.50'),
  isActive: true,
  supportsCod: true,
};

const area = {
  id: AREA_ID,
  code: 'PHNOM-PENH',
  name: 'Phnom Penh',
  codEnabled: true,
};

const snapshotAddress = {
  recipientName: address.recipientName,
  phone: address.phone,
  addressLine1: address.addressLine1,
  addressLine2: address.addressLine2,
  city: address.city,
  stateProvince: address.stateProvince,
  postalCode: address.postalCode,
  countryCode: address.countryCode,
  administrativeLocationPcode: address.administrativeLocationPcode,
};

const snapshotCart = [
  {
    variantId: VARIANT_ID,
    productName: 'Cotton Shirt',
    sku: 'SHIRT-01',
    variantOptionsSnapshot: [{ optionName: 'Size', optionValue: 'M' }],
    unitPrice: '12.50',
    quantity: 2,
    lineTotal: '25.00',
  },
];

const order = {
  id: 'c4d5e6f7-a8b9-4012-9f30-4b5c6d7e8f90',
  userId: USER_ID,
  orderNumber: 'ORD-20261029-AAAAAA',
  status: 'PENDING',
  subtotal: new Prisma.Decimal('25.00'),
  shippingFee: new Prisma.Decimal('3.50'),
  discountAmount: new Prisma.Decimal(0),
  totalAmount: new Prisma.Decimal('28.50'),
  currency: 'USD',
  paymentMethod: 'ABA_PAYWAY',
  shippingProviderId: PROVIDER_ID,
  shippingProviderCode: provider.code,
  shippingProviderName: provider.name,
  codAreaId: null,
  codAreaCode: null,
  codAreaName: null,
  couponCode: null,
  shippingRecipientName: address.recipientName,
  shippingPhone: address.phone,
  shippingAddressLine1: address.addressLine1,
  shippingAddressLine2: null,
  shippingCity: address.city,
  shippingStateProvince: address.stateProvince,
  shippingLocationPcode: address.administrativeLocationPcode,
  shippingLocationSnapshot: address.administrativeLocationPath.map((location) => ({
    pcode: location.pcode,
    adminLevel: location.adminLevel,
    nameEn: location.nameEn,
    nameKm: location.nameKm,
  })),
  shippingPostalCode: null,
  shippingCountryCode: 'KH',
  createdAt: new Date(),
  updatedAt: new Date(),
  items: [],
};

const buildQuote = (overrides: Record<string, unknown> = {}) => ({
  id: QUOTE_ID,
  userId: USER_ID,
  addressId: ADDRESS_ID,
  addressSnapshot: snapshotAddress,
  shippingProviderId: PROVIDER_ID,
  shippingProviderCode: provider.code,
  shippingProviderName: provider.name,
  codAreaId: null,
  codAreaCode: null,
  codAreaName: null,
  paymentMethod: 'ABA_PAYWAY',
  cartSnapshot: snapshotCart,
  subtotal: new Prisma.Decimal('25.00'),
  shippingFee: new Prisma.Decimal('3.50'),
  discountAmount: new Prisma.Decimal(0),
  totalAmount: new Prisma.Decimal('28.50'),
  couponCode: null,
  appliedPromotions: [],
  currency: 'USD',
  expiresAt: new Date(Date.now() + 5 * 60 * 1000),
  consumedAt: null,
  idempotencyKey: null,
  orderId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const buildPromotionSnapshot = (overrides: Record<string, unknown> = {}) => ({
  promotionId: 'f7a8b9c0-d1e2-4f34-8052-6d7e8f901234',
  code: null,
  name: 'Promotion',
  discountType: 'PERCENTAGE',
  percentOff: '10.00',
  amountOff: null,
  discountAmount: '2.50',
  subtotalAtUse: '25.00',
  ...overrides,
});

const buildEvaluation = (overrides: Record<string, unknown> = {}) => ({
  subtotal: new Prisma.Decimal('25.00'),
  shippingFee: new Prisma.Decimal('3.50'),
  discountAmount: new Prisma.Decimal('2.50'),
  totalAmount: new Prisma.Decimal('26.00'),
  coupon: null,
  automatic: null,
  appliedPromotions: [],
  ...overrides,
});

describe('Checkout quotes', () => {
  const mocks = {
    runInTransaction: vi.fn(),
    findByUserId: vi.fn(),
    findForCheckout: vi.fn(),
    deleteItemsByCart: vi.fn(),
    findByVariantId: vi.fn(),
    reserve: vi.fn(),
    drawOrderNumber: vi.fn(),
    resolveOrderLines: vi.fn(),
    writeOrder: vi.fn(),
    isOrderNumberCollision: vi.fn(),
    lockCheckoutCatalog: vi.fn(),
    findById: vi.fn(),
    findOne: vi.fn(),
    findByIdempotencyKey: vi.fn(),
    findForOwner: vi.fn(),
    createQuote: vi.fn(),
    consume: vi.fn(),
    findProviderForCheckout: vi.fn(),
    findAreaForCheckout: vi.fn(),
    assertCodEligible: vi.fn(),
    findUser: vi.fn(),
    evaluatePromotions: vi.fn(),
    createPromotionUsages: vi.fn(),
  };
  let service: CheckoutService;

  beforeEach(() => {
    vi.resetAllMocks();
    txQueryRaw.mockResolvedValue([]);
    mocks.runInTransaction.mockImplementation(
      (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => work(TX),
    );
    mocks.findByUserId.mockResolvedValue(cart);
    mocks.findForCheckout.mockResolvedValue(cart);
    mocks.deleteItemsByCart.mockResolvedValue(1);
    mocks.findByVariantId.mockResolvedValue({
      quantity: 8,
      reservedQuantity: 0,
    });
    mocks.reserve.mockResolvedValue(1);
    mocks.drawOrderNumber.mockResolvedValue('ORD-20261029-AAAAAA');
    mocks.resolveOrderLines.mockResolvedValue([resolvedLine]);
    mocks.writeOrder.mockResolvedValue(order);
    mocks.isOrderNumberCollision.mockReturnValue(false);
    mocks.findById.mockResolvedValue(null);
    mocks.findOne.mockResolvedValue(address);
    mocks.findByIdempotencyKey.mockResolvedValue(null);
    mocks.findForOwner.mockResolvedValue(buildQuote());
    mocks.createQuote.mockResolvedValue({
      id: QUOTE_ID,
      addressId: ADDRESS_ID,
      currency: 'USD',
    });
    mocks.consume.mockResolvedValue({ count: 1 });
    mocks.findProviderForCheckout.mockResolvedValue(provider);
    mocks.findAreaForCheckout.mockResolvedValue(area);
    mocks.assertCodEligible.mockResolvedValue(address.administrativeLocationPath);
    mocks.findUser.mockResolvedValue({ id: USER_ID });
    mocks.evaluatePromotions.mockResolvedValue({
      subtotal: new Prisma.Decimal('25.00'),
      shippingFee: new Prisma.Decimal('3.50'),
      discountAmount: new Prisma.Decimal(0),
      totalAmount: new Prisma.Decimal('28.50'),
      coupon: null,
      automatic: null,
      appliedPromotions: [],
    });
    mocks.createPromotionUsages.mockResolvedValue({ count: 0 });

    service = new CheckoutService(
      {
        runInTransaction: mocks.runInTransaction,
        findByUserId: mocks.findByUserId,
        findForCheckout: mocks.findForCheckout,
        deleteItemsByCart: mocks.deleteItemsByCart,
      } as unknown as CartRepository,
      {
        findByVariantId: mocks.findByVariantId,
        reserve: mocks.reserve,
      } as unknown as InventoryRepository,
      {
        drawOrderNumber: mocks.drawOrderNumber,
        resolveOrderLines: mocks.resolveOrderLines,
        writeOrder: mocks.writeOrder,
        isOrderNumberCollision: mocks.isOrderNumberCollision,
      } as unknown as OrderService,
      {
        findById: mocks.findById,
        lockCheckoutCatalog: mocks.lockCheckoutCatalog,
      } as unknown as OrderRepository,
      { findOne: mocks.findOne } as unknown as AddressesService,
      { findById: mocks.findUser } as unknown as UsersRepository,
      {
        findForCheckout: mocks.findProviderForCheckout,
      } as unknown as ShippingProvidersRepository,
      {
        findForCheckout: mocks.findAreaForCheckout,
      } as unknown as CodAreasRepository,
      {
        create: mocks.createQuote,
        findByIdempotencyKey: mocks.findByIdempotencyKey,
        findForOwner: mocks.findForOwner,
        consume: mocks.consume,
      } as unknown as CheckoutQuotesRepository,
      {
        assertCodEligible: mocks.assertCodEligible,
      } as unknown as AdministrativeLocationsService,
      {
        evaluate: mocks.evaluatePromotions,
      } as unknown as PromotionEvaluatorService,
      {
        createUsages: mocks.createPromotionUsages,
      } as unknown as PromotionsRepository,
    );
  });

  it('creates a server-priced quote with a ten-minute expiry and provider snapshot', async () => {
    const before = Date.now();
    const result = await service.createQuote(USER_ID, {
      addressId: ADDRESS_ID,
      shippingProviderId: PROVIDER_ID,
      paymentMethod: 'ABA_PAYWAY',
    });

    expect(result.totalAmount).toBe('28.50');
    expect(result.subtotal).toBe('25.00');
    expect(result.shippingFee).toBe('3.50');
    expect(result.shippingProvider).toMatchObject({
      id: PROVIDER_ID,
      code: 'LOCAL-DELIVERY',
      fee: '3.50',
    });
    expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(
      before + 10 * 60 * 1000 - 20,
    );
    expect(mocks.createQuote).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentMethod: 'ABA_PAYWAY',
        subtotal: '25.00',
        shippingFee: '3.50',
        totalAmount: '28.50',
        currency: 'USD',
        addressSnapshot: snapshotAddress,
        cartSnapshot: snapshotCart,
      }),
      TX,
    );
  });

  it('does not issue a quote for an address the caller does not own', async () => {
    mocks.findOne.mockRejectedValueOnce(new NotFoundException());
    await expect(
      service.createQuote(USER_ID, {
        addressId: ADDRESS_ID,
        shippingProviderId: PROVIDER_ID,
        paymentMethod: 'ABA_PAYWAY',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(mocks.createQuote).not.toHaveBeenCalled();
  });

  it('rejects missing and inactive providers', async () => {
    mocks.findProviderForCheckout.mockResolvedValueOnce(null);
    await expect(
      service.createQuote(USER_ID, {
        addressId: ADDRESS_ID,
        shippingProviderId: PROVIDER_ID,
        paymentMethod: 'ABA_PAYWAY',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    mocks.findProviderForCheckout.mockResolvedValueOnce({
      ...provider,
      isActive: false,
    });
    await expect(
      service.createQuote(USER_ID, {
        addressId: ADDRESS_ID,
        shippingProviderId: PROVIDER_ID,
        paymentMethod: 'ABA_PAYWAY',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('requires COD provider support and eligible address-based location', async () => {
    mocks.findProviderForCheckout.mockResolvedValueOnce({
      ...provider,
      supportsCod: false,
    });
    await expect(
      service.createQuote(USER_ID, {
        addressId: ADDRESS_ID,
        shippingProviderId: PROVIDER_ID,
        paymentMethod: 'COD',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    mocks.findProviderForCheckout.mockResolvedValueOnce(provider);
    mocks.assertCodEligible.mockRejectedValueOnce(new ConflictException());
    await expect(
      service.createQuote(USER_ID, {
        addressId: ADDRESS_ID,
        shippingProviderId: PROVIDER_ID,
        paymentMethod: 'COD',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(mocks.createQuote).not.toHaveBeenCalled();
  });

  it('returns the canonical address location path and no customer-selected COD area', async () => {
    const result = await service.createQuote(USER_ID, {
      addressId: ADDRESS_ID,
      shippingProviderId: PROVIDER_ID,
      paymentMethod: 'COD',
    });

    expect(result.paymentMethod).toBe('COD');
    expect(result.administrativeLocationPath).toMatchObject([
      { adminLevel: 1, nameEn: 'Phnom Penh' },
      { adminLevel: 2, nameEn: 'Chamkar Mon' },
      { adminLevel: 3, nameEn: 'Tonle Bassac' },
    ]);
    expect(mocks.createQuote).toHaveBeenCalledWith(
      expect.objectContaining({
        codAreaId: null,
        codAreaCode: null,
        codAreaName: null,
      }),
      TX,
    );
  });

  it('rejects expired and cross-user quotes before creating an order', async () => {
    mocks.findForOwner.mockResolvedValueOnce(null);
    await expect(
      service.checkout(USER_ID, {
        quoteId: QUOTE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    mocks.findForOwner.mockResolvedValueOnce(
      buildQuote({ expiresAt: new Date(Date.now() - 1) }),
    );
    await expect(
      service.checkout(USER_ID, {
        quoteId: QUOTE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(mocks.writeOrder).not.toHaveBeenCalled();
  });

  it('invalidates a quote if the cart or provider fee changed', async () => {
    mocks.findForOwner.mockResolvedValueOnce(
      buildQuote({
        cartSnapshot: [{ ...snapshotCart[0], unitPrice: '12.51' }],
      }),
    );
    await expect(
      service.checkout(USER_ID, {
        quoteId: QUOTE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    mocks.findForOwner.mockResolvedValueOnce(buildQuote());
    mocks.findProviderForCheckout.mockResolvedValueOnce({
      ...provider,
      baseFee: new Prisma.Decimal('4.00'),
    });
    await expect(
      service.checkout(USER_ID, {
        quoteId: QUOTE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(mocks.writeOrder).not.toHaveBeenCalled();
  });

  it('invalidates quotes after provider, product-price, or COD eligibility changes', async () => {
    mocks.findForOwner.mockResolvedValueOnce(buildQuote());
    mocks.findProviderForCheckout.mockResolvedValueOnce({
      ...provider,
      isActive: false,
    });
    await expect(
      service.checkout(USER_ID, {
        quoteId: QUOTE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    mocks.findForOwner.mockResolvedValueOnce(buildQuote());
    mocks.resolveOrderLines.mockResolvedValueOnce([
      { ...resolvedLine, unitPrice: new Prisma.Decimal('13.00') },
    ]);
    await expect(
      service.checkout(USER_ID, {
        quoteId: QUOTE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    mocks.findForOwner.mockResolvedValueOnce(
      buildQuote({
        paymentMethod: 'COD',
      }),
    );
    mocks.assertCodEligible.mockRejectedValueOnce(new ConflictException());
    await expect(
      service.checkout(USER_ID, {
        quoteId: QUOTE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(mocks.writeOrder).not.toHaveBeenCalled();
  });

  it('consumes a valid quote atomically with order creation and cart clearing', async () => {
    mocks.findForOwner.mockResolvedValueOnce(buildQuote());
    const result = await service.checkout(USER_ID, {
      quoteId: QUOTE_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(result.orderNumber).toBe(order.orderNumber);
    expect(mocks.reserve).toHaveBeenCalledWith(VARIANT_ID, 2, TX);
    expect(mocks.writeOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        shippingFee: '3.50',
        paymentMethod: 'ABA_PAYWAY',
        shippingProviderId: PROVIDER_ID,
      }),
      [resolvedLine],
      'ORD-20261029-AAAAAA',
      TX,
    );
    expect(mocks.deleteItemsByCart).toHaveBeenCalled();
    expect(mocks.consume).toHaveBeenCalledWith(
      QUOTE_ID,
      USER_ID,
      IDEMPOTENCY_KEY,
      order.id,
      TX,
    );
    expect(mocks.runInTransaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    expect(mocks.findForCheckout).toHaveBeenCalledWith(USER_ID, TX);
    expect(mocks.findForOwner).toHaveBeenCalledWith(QUOTE_ID, USER_ID, TX);
  });

  it('does not write an order or clear the cart when stock reservation fails', async () => {
    mocks.findForOwner.mockResolvedValueOnce(buildQuote());
    mocks.findByVariantId.mockResolvedValueOnce({
      quantity: 2,
      reservedQuantity: 0,
    });
    mocks.reserve.mockResolvedValueOnce(0);

    await expect(
      service.checkout(USER_ID, {
        quoteId: QUOTE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(mocks.writeOrder).not.toHaveBeenCalled();
    expect(mocks.deleteItemsByCart).not.toHaveBeenCalled();
    expect(mocks.consume).not.toHaveBeenCalled();
  });

  it('replays the same completed checkout for a duplicate idempotency key', async () => {
    mocks.findByIdempotencyKey.mockResolvedValueOnce({
      id: QUOTE_ID,
      orderId: order.id,
    });
    mocks.findById.mockResolvedValueOnce(order);

    const result = await service.checkout(USER_ID, {
      quoteId: QUOTE_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(result.orderNumber).toBe(order.orderNumber);
    expect(mocks.runInTransaction).not.toHaveBeenCalled();
  });

  describe('promotion integration', () => {
    const automaticSnapshot = buildPromotionSnapshot({
      promotionId: 'f8b9c0d1-e2f3-4056-8173-7e8f90123456',
      code: null,
      name: 'Automatic 10%',
      discountAmount: '2.50',
    });
    const couponSnapshot = buildPromotionSnapshot({
      promotionId: 'f9c0d1e2-f3a4-4067-8284-8f9012345678',
      code: 'SAVE10',
      name: 'Save 10',
      discountAmount: '2.50',
    });

    it('applies the best automatic promotion without a coupon and persists its snapshot', async () => {
      mocks.evaluatePromotions.mockResolvedValueOnce(
        buildEvaluation({
          automatic: automaticSnapshot,
          appliedPromotions: [automaticSnapshot],
          discountAmount: new Prisma.Decimal('2.50'),
          totalAmount: new Prisma.Decimal('26.00'),
        }),
      );

      const result = await service.createQuote(USER_ID, {
        addressId: ADDRESS_ID,
        shippingProviderId: PROVIDER_ID,
        paymentMethod: 'ABA_PAYWAY',
      });

      expect(result.couponCode).toBeNull();
      expect(result.appliedCoupon).toBeNull();
      expect(result.appliedAutomaticPromotion).toEqual(automaticSnapshot);
      expect(result.appliedPromotions).toEqual([automaticSnapshot]);
      expect(result.discountAmount).toBe('2.50');
      expect(result.totalAmount).toBe('26.00');
      expect(mocks.evaluatePromotions).toHaveBeenCalledWith(
        expect.objectContaining({ userId: USER_ID, couponCode: null }),
        TX,
      );
      expect(mocks.createQuote).toHaveBeenCalledWith(
        expect.objectContaining({
          couponCode: null,
          appliedPromotions: [automaticSnapshot],
          discountAmount: '2.50',
          totalAmount: '26.00',
        }),
        TX,
      );
    });

    it('normalises a coupon and stacks it with the best automatic promotion', async () => {
      mocks.evaluatePromotions.mockResolvedValueOnce(
        buildEvaluation({
          coupon: couponSnapshot,
          automatic: automaticSnapshot,
          appliedPromotions: [couponSnapshot, automaticSnapshot],
          discountAmount: new Prisma.Decimal('5.00'),
          totalAmount: new Prisma.Decimal('23.50'),
        }),
      );

      const result = await service.createQuote(USER_ID, {
        addressId: ADDRESS_ID,
        shippingProviderId: PROVIDER_ID,
        paymentMethod: 'ABA_PAYWAY',
        couponCode: '  save10  ',
      });

      expect(mocks.evaluatePromotions).toHaveBeenCalledWith(
        expect.objectContaining({ couponCode: 'SAVE10' }),
        TX,
      );
      expect(result.couponCode).toBe('SAVE10');
      expect(result.appliedCoupon).toEqual(couponSnapshot);
      expect(result.appliedAutomaticPromotion).toEqual(automaticSnapshot);
      expect(result.appliedPromotions).toEqual([
        couponSnapshot,
        automaticSnapshot,
      ]);
      expect(result.discountAmount).toBe('5.00');
      expect(result.totalAmount).toBe('23.50');
      expect(mocks.createQuote).toHaveBeenCalledWith(
        expect.objectContaining({
          couponCode: 'SAVE10',
          appliedPromotions: [couponSnapshot, automaticSnapshot],
          discountAmount: '5.00',
          totalAmount: '23.50',
        }),
        TX,
      );
    });

    it.each(['NOPE', 'EXPIRED', 'PAUSED', 'ARCHIVED', 'EXHAUSTED'])(
      'rejects the %s coupon instead of silently ignoring it',
      async (couponCode) => {
        mocks.evaluatePromotions.mockResolvedValueOnce(
          buildEvaluation({
            discountAmount: new Prisma.Decimal(0),
            totalAmount: new Prisma.Decimal('28.50'),
          }),
        );

        const error = await service
          .createQuote(USER_ID, {
            addressId: ADDRESS_ID,
            shippingProviderId: PROVIDER_ID,
            paymentMethod: 'ABA_PAYWAY',
            couponCode,
          })
          .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as Error).message).toMatch(/coupon/i);
        expect(mocks.createQuote).not.toHaveBeenCalled();
      },
    );

    it('writes the authoritative coupon totals to the order and records its usage inside the transaction', async () => {
      mocks.evaluatePromotions.mockResolvedValueOnce(
        buildEvaluation({
          coupon: couponSnapshot,
          appliedPromotions: [couponSnapshot],
          discountAmount: new Prisma.Decimal('2.50'),
          totalAmount: new Prisma.Decimal('26.00'),
        }),
      );
      mocks.findForOwner.mockResolvedValueOnce(
        buildQuote({
          couponCode: 'SAVE10',
          discountAmount: new Prisma.Decimal('2.50'),
          totalAmount: new Prisma.Decimal('26.00'),
          appliedPromotions: [couponSnapshot],
        }),
      );
      mocks.writeOrder.mockResolvedValueOnce({
        ...order,
        couponCode: 'SAVE10',
        discountAmount: new Prisma.Decimal('2.50'),
        totalAmount: new Prisma.Decimal('26.00'),
      });

      const result = await service.checkout(USER_ID, {
        quoteId: QUOTE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      });

      expect(mocks.evaluatePromotions).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: USER_ID,
          couponCode: 'SAVE10',
        }),
        TX,
      );
      expect(mocks.writeOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          couponCode: 'SAVE10',
          discountAmount: '2.50',
          shippingFee: '3.50',
        }),
        [resolvedLine],
        'ORD-20261029-AAAAAA',
        TX,
      );
      expect(mocks.createPromotionUsages).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            promotionId: couponSnapshot.promotionId,
            orderId: order.id,
            userId: USER_ID,
            codeSnapshot: 'SAVE10',
            nameSnapshot: couponSnapshot.name,
            discountType: couponSnapshot.discountType,
            discountAmount: '2.50',
            subtotalAtUse: '25.00',
          }),
        ],
        TX,
      );
      expect(result.couponCode).toBe('SAVE10');
      expect(result.discountAmount).toBe('2.50');
      expect(result.totalAmount).toBe('26.00');
    });

    it('records one usage row for each applied promotion', async () => {
      mocks.evaluatePromotions.mockResolvedValueOnce(
        buildEvaluation({
          coupon: couponSnapshot,
          automatic: automaticSnapshot,
          appliedPromotions: [couponSnapshot, automaticSnapshot],
          discountAmount: new Prisma.Decimal('5.00'),
          totalAmount: new Prisma.Decimal('23.50'),
        }),
      );
      mocks.findForOwner.mockResolvedValueOnce(
        buildQuote({
          couponCode: 'SAVE10',
          discountAmount: new Prisma.Decimal('5.00'),
          totalAmount: new Prisma.Decimal('23.50'),
          appliedPromotions: [couponSnapshot, automaticSnapshot],
        }),
      );
      mocks.writeOrder.mockResolvedValueOnce({
        ...order,
        couponCode: 'SAVE10',
        discountAmount: new Prisma.Decimal('5.00'),
        totalAmount: new Prisma.Decimal('23.50'),
      });

      await service.checkout(USER_ID, {
        quoteId: QUOTE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      });

      expect(mocks.createPromotionUsages).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            promotionId: couponSnapshot.promotionId,
            codeSnapshot: 'SAVE10',
          }),
          expect.objectContaining({
            promotionId: automaticSnapshot.promotionId,
            codeSnapshot: null,
          }),
        ]),
        TX,
      );
      expect(
        (mocks.createPromotionUsages.mock.calls[0][0] as unknown[]).length,
      ).toBe(2);
    });

    it('does not write a usage row when no promotion applied', async () => {
      await service.checkout(USER_ID, {
        quoteId: QUOTE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
      });

      expect(mocks.createPromotionUsages).not.toHaveBeenCalled();
    });

    it('rejects checkout when a quoted coupon is no longer eligible', async () => {
      mocks.findForOwner.mockResolvedValueOnce(
        buildQuote({
          couponCode: 'SAVE10',
          discountAmount: new Prisma.Decimal('2.50'),
          totalAmount: new Prisma.Decimal('26.00'),
        }),
      );

      const error = await service
        .checkout(USER_ID, {
          quoteId: QUOTE_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
        })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as Error).message).toMatch(/coupon/i);
      expect(mocks.writeOrder).not.toHaveBeenCalled();
      expect(mocks.createPromotionUsages).not.toHaveBeenCalled();
      expect(mocks.consume).not.toHaveBeenCalled();
    });

    it('rejects a quote whose discount no longer matches the server calculation', async () => {
      mocks.findForOwner.mockResolvedValueOnce(
        buildQuote({
          discountAmount: new Prisma.Decimal('10.00'),
          totalAmount: new Prisma.Decimal('18.50'),
        }),
      );
      mocks.evaluatePromotions.mockResolvedValueOnce(
        buildEvaluation({
          discountAmount: new Prisma.Decimal(0),
          totalAmount: new Prisma.Decimal('28.50'),
        }),
      );

      await expect(
        service.checkout(USER_ID, {
          quoteId: QUOTE_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
        }),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(mocks.writeOrder).not.toHaveBeenCalled();
      expect(mocks.createPromotionUsages).not.toHaveBeenCalled();
    });

    it.each(['ABA_PAYWAY', 'COD'] as const)(
      'preserves the authoritative total for %s checkout',
      async (paymentMethod) => {
        mocks.findForOwner.mockResolvedValueOnce(
          buildQuote({
            paymentMethod,
            couponCode: 'SAVE10',
            discountAmount: new Prisma.Decimal('2.50'),
            totalAmount: new Prisma.Decimal('26.00'),
          }),
        );
        mocks.evaluatePromotions.mockResolvedValueOnce(
          buildEvaluation({
            coupon: couponSnapshot,
            appliedPromotions: [couponSnapshot],
            discountAmount: new Prisma.Decimal('2.50'),
            totalAmount: new Prisma.Decimal('26.00'),
          }),
        );
        mocks.writeOrder.mockResolvedValueOnce({
          ...order,
          paymentMethod,
          couponCode: 'SAVE10',
          discountAmount: new Prisma.Decimal('2.50'),
          totalAmount: new Prisma.Decimal('26.00'),
        });

        const result = await service.checkout(USER_ID, {
          quoteId: QUOTE_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
        });

        expect(mocks.writeOrder).toHaveBeenCalledWith(
          expect.objectContaining({
            paymentMethod,
            couponCode: 'SAVE10',
            discountAmount: '2.50',
          }),
          [resolvedLine],
          'ORD-20261029-AAAAAA',
          TX,
        );
        expect(result.paymentMethod).toBe(paymentMethod);
        expect(result.discountAmount).toBe('2.50');
        expect(result.totalAmount).toBe('26.00');
      },
    );

    it('leaves the cart and quote untouched when usage recording fails', async () => {
      mocks.evaluatePromotions.mockResolvedValueOnce(
        buildEvaluation({
          coupon: couponSnapshot,
          appliedPromotions: [couponSnapshot],
          discountAmount: new Prisma.Decimal('2.50'),
          totalAmount: new Prisma.Decimal('26.00'),
        }),
      );
      mocks.findForOwner.mockResolvedValueOnce(
        buildQuote({
          couponCode: 'SAVE10',
          discountAmount: new Prisma.Decimal('2.50'),
          totalAmount: new Prisma.Decimal('26.00'),
        }),
      );
      mocks.createPromotionUsages.mockRejectedValueOnce(
        new Error('usage write failed'),
      );

      await expect(
        service.checkout(USER_ID, {
          quoteId: QUOTE_ID,
          idempotencyKey: IDEMPOTENCY_KEY,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.writeOrder).toHaveBeenCalled();
      expect(mocks.deleteItemsByCart).not.toHaveBeenCalled();
      expect(mocks.consume).not.toHaveBeenCalled();
    });
  });
});
