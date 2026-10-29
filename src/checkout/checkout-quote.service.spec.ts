import { ConflictException, NotFoundException } from '@nestjs/common';
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
  currency: 'USD',
  expiresAt: new Date(Date.now() + 5 * 60 * 1000),
  consumedAt: null,
  idempotencyKey: null,
  orderId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
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
});
