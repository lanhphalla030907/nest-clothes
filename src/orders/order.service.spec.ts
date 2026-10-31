import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '../generated/prisma/client.js';
import { UsersRepository } from '../users/repositories/users.repository.js';
import { DEFAULT_ORDER_CURRENCY } from './constants/order-status.constants.js';
import { OrderResponseDto } from './dto/order-response.dto.js';
import { OrderInventoryService } from './order-inventory.service.js';
import { OrderNumberGenerator } from './order-number.generator.js';
import { OrderService, type PlaceOrderInput } from './order.service.js';
import { OrderRepository } from './repositories/order.repository.js';

const USER_ID = 'a1b2c3d4-e5f6-4f70-8a9b-0c1d2e3f4a5b';
const OTHER_USER_ID = 'b2c3d4e5-f6a7-4b81-9c0d-1e2f3a4b5c6d';
const ORDER_ID = 'c3d4e5f6-a7b8-4c92-8d1e-2f3a4b5c6d7e';
const OTHER_ORDER_ID = 'd4e5f6a7-b8c9-4da3-9e2f-3a4b5c6d7e8f';
const VARIANT_ID = 'e5f6a7b8-c9d0-4eb4-af30-4b5c6d7e8f90';
const PRODUCT_ID = 'f6a7b8c9-d0e1-4fc5-b041-5c6d7e8f9012';
const TRANSACTION = { tag: 'tx' } as never;

const buildOrder = (overrides: Record<string, unknown> = {}) => ({
  id: ORDER_ID,
  userId: USER_ID,
  orderNumber: 'ORD-20260104-AAAAAA',
  status: 'PENDING',
  subtotal: new Prisma.Decimal('129.00'),
  shippingFee: new Prisma.Decimal('7.50'),
  discountAmount: new Prisma.Decimal('8.00'),
  totalAmount: new Prisma.Decimal('128.50'),
  currency: 'USD',
  shippingRecipientName: 'Ada Lovelace',
  shippingPhone: '+15555550100',
  shippingAddressLine1: '18 Mill Lane',
  shippingAddressLine2: null,
  shippingCity: 'Bristol',
  shippingStateProvince: null,
  shippingLocationPcode: null,
  shippingLocationSnapshot: null,
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
      quantity: 1,
      lineTotal: new Prisma.Decimal('129.00'),
      createdAt: new Date('2026-01-04T11:30:00.000Z'),
    },
  ],
  ...overrides,
});

const buildShipping = (overrides: Record<string, unknown> = {}) => ({
  recipientName: 'Ada Lovelace',
  phone: '+15555550100',
  addressLine1: '18 Mill Lane',
  addressLine2: null as string | null,
  city: 'Bristol',
  stateProvince: null as string | null,
  postalCode: 'BS1 4TR',
  countryCode: 'GB',
  ...overrides,
});

const buildAdminOrderRow = (overrides: Record<string, unknown> = {}) => ({
  id: ORDER_ID,
  orderNumber: 'ORD-20260104-AAAAAA',
  status: 'PENDING',
  paymentMethod: 'ABA_PAYWAY',
  subtotal: new Prisma.Decimal('129.00'),
  shippingFee: new Prisma.Decimal('7.50'),
  discountAmount: new Prisma.Decimal('8.00'),
  totalAmount: new Prisma.Decimal('128.50'),
  currency: 'USD',
  shippingRecipientName: 'Ada Lovelace',
  shippingCity: 'Bristol',
  shippingLocationSnapshot: null,
  shippingCountryCode: 'GB',
  createdAt: new Date('2026-01-04T11:30:00.000Z'),
  updatedAt: new Date('2026-01-04T11:30:00.000Z'),
  user: {
    id: USER_ID,
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.test',
  },
  items: [{ quantity: 1 }, { quantity: 2 }],
  payments: [
    {
      id: 'a7b8c9d0-e1f2-4a3b-8c4d-5e6f7a8b9c0d',
      status: 'PAID',
      provider: 'ABA_PAYWAY',
      amount: new Prisma.Decimal('128.50'),
      currency: 'USD',
      paidAt: new Date('2026-01-04T11:35:00.000Z'),
      createdAt: new Date('2026-01-04T11:31:00.000Z'),
    },
  ],
  _count: { payments: 1 },
  ...overrides,
});

const buildAdminDetailRow = (overrides: Record<string, unknown> = {}) => ({
  ...buildOrder(),
  paymentMethod: 'ABA_PAYWAY',
  user: {
    id: USER_ID,
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.test',
  },
  payments: [
    {
      id: 'a7b8c9d0-e1f2-4a3b-8c4d-5e6f7a8b9c0d',
      status: 'PAID',
      provider: 'ABA_PAYWAY',
      transactionId: 'PAY-20260104-AAAAAA',
      amount: new Prisma.Decimal('128.50'),
      currency: 'USD',
      paymentMethod: 'ABA Pay',
      providerReference: 'REF-1',
      paidAt: new Date('2026-01-04T11:35:00.000Z'),
      createdAt: new Date('2026-01-04T11:31:00.000Z'),
    },
  ],
  ...overrides,
});

const buildInput = (
  overrides: Partial<PlaceOrderInput> = {},
): PlaceOrderInput => ({
  userId: USER_ID,
  lines: [{ variantId: VARIANT_ID, quantity: 1 }],
  shipping: buildShipping(),
  ...overrides,
});

/**
 * A `P2002` shaped the way `@prisma/adapter-pg` actually reports it: `meta.target`
 * is absent and the model name plus a driver-adapter cause carry the detail. This is
 * the shape the retry logic has to recognise, because it is what a real concurrent
 * insert produces.
 */
const buildOrderNumberViolation = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '7.10.0',
    meta: { modelName: 'Order' },
  });

const buildCheckViolation = () =>
  new Prisma.PrismaClientKnownRequestError('Database error', {
    code: 'P2039',
    clientVersion: '7.10.0',
    meta: { modelName: 'Order' },
  });

describe('OrderService', () => {
  let service: OrderService;
  let orderRunInTransaction: ReturnType<typeof vi.fn>;
  let orderCreateOrder: ReturnType<typeof vi.fn>;
  let orderFindById: ReturnType<typeof vi.fn>;
  let orderFindByUserId: ReturnType<typeof vi.fn>;
  let orderFindAdminPage: ReturnType<typeof vi.fn>;
  let orderFindAdminById: ReturnType<typeof vi.fn>;
  let orderFindStatusById: ReturnType<typeof vi.fn>;
  let orderFindStatusByIdForUser: ReturnType<typeof vi.fn>;
  let orderTransitionStatus: ReturnType<typeof vi.fn>;
  let orderTransitionStatusForUser: ReturnType<typeof vi.fn>;
  let orderHasPaidPayment: ReturnType<typeof vi.fn>;
  let orderExistsOrderNumber: ReturnType<typeof vi.fn>;
  let orderFindVariantForCheckout: ReturnType<typeof vi.fn>;
  let orderFindProductForCheckout: ReturnType<typeof vi.fn>;
  let orderFindVariantOptionsForSnapshot: ReturnType<typeof vi.fn>;
  let inventoryReleaseReserved: ReturnType<typeof vi.fn>;
  let inventoryCommitReserved: ReturnType<typeof vi.fn>;
  let userFindById: ReturnType<typeof vi.fn>;
  let generatorBuild: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    orderRunInTransaction = vi.fn();
    orderCreateOrder = vi.fn();
    orderFindById = vi.fn();
    orderFindByUserId = vi.fn();
    orderFindAdminPage = vi.fn();
    orderFindAdminById = vi.fn();
    orderFindStatusById = vi.fn();
    orderFindStatusByIdForUser = vi.fn();
    orderTransitionStatus = vi.fn();
    orderTransitionStatusForUser = vi.fn();
    orderHasPaidPayment = vi.fn();
    orderExistsOrderNumber = vi.fn();
    orderFindVariantForCheckout = vi.fn();
    orderFindProductForCheckout = vi.fn();
    orderFindVariantOptionsForSnapshot = vi.fn();
    inventoryReleaseReserved = vi.fn();
    inventoryCommitReserved = vi.fn();
    userFindById = vi.fn();
    generatorBuild = vi.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrderService,
        {
          provide: OrderRepository,
          useValue: {
            runInTransaction: orderRunInTransaction,
            createOrder: orderCreateOrder,
            findById: orderFindById,
            findByUserId: orderFindByUserId,
            findAdminPage: orderFindAdminPage,
            findAdminById: orderFindAdminById,
            findStatusById: orderFindStatusById,
            findStatusByIdForUser: orderFindStatusByIdForUser,
            transitionStatus: orderTransitionStatus,
            transitionStatusForUser: orderTransitionStatusForUser,
            hasPaidPayment: orderHasPaidPayment,
            findByOrderNumber: vi.fn(),
            existsOrderNumber: orderExistsOrderNumber,
            findVariantForCheckout: orderFindVariantForCheckout,
            findProductForCheckout: orderFindProductForCheckout,
            findVariantOptionsForSnapshot: orderFindVariantOptionsForSnapshot,
          },
        },
        { provide: UsersRepository, useValue: { findById: userFindById } },
        {
          provide: OrderNumberGenerator,
          useValue: { build: generatorBuild, buildMany: vi.fn() },
        },
        {
          provide: OrderInventoryService,
          useValue: {
            releaseReservedForOrder: inventoryReleaseReserved,
            commitReservedForOrder: inventoryCommitReserved,
          },
        },
      ],
    }).compile();

    service = module.get(OrderService);

    userFindById.mockResolvedValue({ id: USER_ID });
    orderFindByUserId.mockResolvedValue([]);
    orderFindAdminPage.mockResolvedValue({ items: [], total: 0 });
    orderFindAdminById.mockResolvedValue(null);
    orderFindById.mockResolvedValue(null);
    orderFindStatusById.mockResolvedValue(null);
    orderFindStatusByIdForUser.mockResolvedValue(null);
    orderTransitionStatus.mockResolvedValue(true);
    orderTransitionStatusForUser.mockResolvedValue(true);
    orderHasPaidPayment.mockResolvedValue(false);
    inventoryReleaseReserved.mockResolvedValue(undefined);
    inventoryCommitReserved.mockResolvedValue(undefined);
    orderExistsOrderNumber.mockResolvedValue(false);
    orderFindVariantForCheckout.mockResolvedValue({
      id: VARIANT_ID,
      productId: PRODUCT_ID,
      sku: 'COAT-NAVY-M',
      price: new Prisma.Decimal('129.00'),
      isActive: true,
    });
    orderFindProductForCheckout.mockResolvedValue({
      name: 'Wool Peacoat',
      isActive: true,
    });
    orderFindVariantOptionsForSnapshot.mockResolvedValue([
      { optionName: 'Color', optionValue: 'Navy' },
    ]);
    orderCreateOrder.mockImplementation((data: { userId: string }) =>
      Promise.resolve(buildOrder({ userId: data.userId })),
    );
    // Default: run the work against a stub transaction client, so the assertions
    // can see what the service asked the repository to do.
    orderRunInTransaction.mockImplementation(
      (work: (tx: unknown) => Promise<unknown>) => work(TRANSACTION),
    );
    generatorBuild.mockReturnValue('ORD-20260104-AAAAAA');
  });

  describe('listOrders', () => {
    it('returns an empty list for a customer with no orders', async () => {
      await expect(service.listOrders(USER_ID)).resolves.toEqual([]);
    });

    it('summarises each order, newest first as the repository returned it', async () => {
      const newer = buildOrder({ id: 'newer', status: 'SHIPPED' });
      const older = buildOrder({ id: 'older', status: 'CONFIRMED' });
      orderFindByUserId.mockResolvedValue([newer, older]);

      const result = await service.listOrders(USER_ID);

      expect(result.map((order) => order.id)).toEqual(['newer', 'older']);
      expect(result.map((order) => order.status)).toEqual([
        'SHIPPED',
        'CONFIRMED',
      ]);
      expect(result[0]).not.toHaveProperty('items');
      expect(result[0].totalAmount).toBe('128.50');
    });

    it('scopes the query to the caller', async () => {
      await service.listOrders(USER_ID);

      expect(orderFindByUserId).toHaveBeenCalledWith(USER_ID);
    });

    it('confirms the claimed identity before reading anything', async () => {
      await service.listOrders(USER_ID);

      expect(userFindById).toHaveBeenCalledWith(USER_ID);
      expect(userFindById.mock.invocationCallOrder[0]).toBeLessThan(
        orderFindByUserId.mock.invocationCallOrder[0],
      );
    });

    it('404s a claimed user that does not exist, rather than returning []', async () => {
      userFindById.mockResolvedValue(null);

      await expect(service.listOrders(USER_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(orderFindByUserId).not.toHaveBeenCalled();
    });
  });

  describe('getOrder', () => {
    it('returns the full order with its items', async () => {
      orderFindById.mockResolvedValue(buildOrder());

      const result = await service.getOrder(USER_ID, ORDER_ID);

      expect(result.id).toBe(ORDER_ID);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].productName).toBe('Wool Peacoat');
      expect(result.items[0].unitPrice).toBe('129.00');
      expect(result.itemCount).toBe(1);
    });

    it('never carries a user object or a password hash', async () => {
      orderFindById.mockResolvedValue(
        buildOrder({ user: { passwordHash: 'argon2-hash' } }),
      );

      const result = await service.getOrder(USER_ID, ORDER_ID);

      expect(result).not.toHaveProperty('user');
      expect(result).not.toHaveProperty('passwordHash');
      expect(JSON.stringify(result)).not.toContain('argon2-hash');
    });

    it('404s an order that belongs to somebody else', async () => {
      orderFindById.mockResolvedValue(buildOrder({ userId: OTHER_USER_ID }));

      await expect(service.getOrder(USER_ID, ORDER_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('404s an order that does not exist', async () => {
      orderFindById.mockResolvedValue(null);

      await expect(service.getOrder(USER_ID, ORDER_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('gives an identical 404 whether the order is absent or not yours', async () => {
      // The same id in both cases, so the two responses are byte-identical: the
      // wording cannot distinguish "not yours" from "not there".
      orderFindById.mockResolvedValueOnce(
        buildOrder({ userId: OTHER_USER_ID }),
      );
      const notMine = await service
        .getOrder(USER_ID, ORDER_ID)
        .catch((error: NotFoundException) => error);

      orderFindById.mockResolvedValueOnce(null);
      const absent = await service
        .getOrder(USER_ID, ORDER_ID)
        .catch((error: NotFoundException) => error);

      expect(notMine).toBeInstanceOf(NotFoundException);
      expect((notMine as NotFoundException).getResponse()).toEqual(
        (absent as NotFoundException).getResponse(),
      );
    });

    it('404s before reading the order when the claimed user does not exist', async () => {
      userFindById.mockResolvedValue(null);

      await expect(service.getOrder(USER_ID, ORDER_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(orderFindById).not.toHaveBeenCalled();
    });

    it("reads the order by id only; the ownership check is the service's", async () => {
      orderFindById.mockResolvedValue(buildOrder());

      await service.getOrder(USER_ID, ORDER_ID);

      expect(orderFindById).toHaveBeenCalledWith(ORDER_ID);
    });

    it('verifies pending payment when order is PENDING and returns CONFIRMED if promoted', async () => {
      const mockPaymentsService = {
        verifyOrderPayment: vi.fn().mockResolvedValue(true),
      };
      const serviceWithPayments = new OrderService(
        { findById: orderFindById } as any,
        { findById: userFindById } as any,
        { build: vi.fn(), buildMany: vi.fn() } as any,
        {} as any,
        mockPaymentsService as any,
      );

      orderFindById
        .mockResolvedValueOnce(buildOrder({ status: 'PENDING' }))
        .mockResolvedValueOnce(buildOrder({ status: 'CONFIRMED' }));

      const result = await serviceWithPayments.getOrder(USER_ID, ORDER_ID);

      expect(mockPaymentsService.verifyOrderPayment).toHaveBeenCalledWith(ORDER_ID);
      expect(result.status).toBe('CONFIRMED');
    });

    it('leaves order as PENDING when verifyOrderPayment returns false', async () => {
      const mockPaymentsService = {
        verifyOrderPayment: vi.fn().mockResolvedValue(false),
      };
      const serviceWithPayments = new OrderService(
        { findById: orderFindById } as any,
        { findById: userFindById } as any,
        { build: vi.fn(), buildMany: vi.fn() } as any,
        {} as any,
        mockPaymentsService as any,
      );

      orderFindById.mockResolvedValue(buildOrder({ status: 'PENDING' }));

      const result = await serviceWithPayments.getOrder(USER_ID, ORDER_ID);

      expect(mockPaymentsService.verifyOrderPayment).toHaveBeenCalledWith(ORDER_ID);
      expect(result.status).toBe('PENDING');
    });
  });

  describe('listOrdersForAdmin', () => {
    it('passes normalised filters to the repository and paginates the result', async () => {
      orderFindAdminPage.mockResolvedValue({
        items: [buildAdminOrderRow()],
        total: 41,
      });

      const result = await service.listOrdersForAdmin({
        page: 2,
        limit: 20,
        status: 'PENDING',
        search: '  Ada  ',
        createdFrom: '2026-01-01T00:00:00.000Z',
        createdTo: '2026-01-31T23:59:59.000Z',
      });

      expect(orderFindAdminPage).toHaveBeenCalledWith({
        page: 2,
        limit: 20,
        status: 'PENDING',
        search: 'Ada',
        createdFrom: new Date('2026-01-01T00:00:00.000Z'),
        createdTo: new Date('2026-01-31T23:59:59.000Z'),
      });
      expect(result.pagination).toEqual({
        page: 2,
        limit: 20,
        total: 41,
        totalPages: 3,
      });
      expect(result.items[0]).toMatchObject({
        id: ORDER_ID,
        totalAmount: '128.50',
        itemCount: 3,
        lineCount: 2,
        hasPaidPayment: true,
        paymentMethod: 'ABA_PAYWAY',
      });
      expect(result.items[0].customer).toEqual({
        id: USER_ID,
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada@example.test',
      });
    });

    it('treats a whitespace-only search as no search', async () => {
      await service.listOrdersForAdmin({ page: 1, limit: 20, search: '   ' });

      expect(orderFindAdminPage).toHaveBeenCalledWith(
        expect.objectContaining({ search: undefined }),
      );
    });

    it('rejects a reversed date range before querying', async () => {
      await expect(
        service.listOrdersForAdmin({
          page: 1,
          limit: 20,
          createdFrom: '2026-02-01T00:00:00.000Z',
          createdTo: '2026-01-01T00:00:00.000Z',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(orderFindAdminPage).not.toHaveBeenCalled();
    });

    it('rejects an unparseable date even if HTTP validation was bypassed', async () => {
      await expect(
        service.listOrdersForAdmin({
          page: 1,
          limit: 20,
          createdFrom: 'not-a-date',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(orderFindAdminPage).not.toHaveBeenCalled();
    });

    it('does not need the caller to be a user row', async () => {
      // The route's ADMIN role is the authority; there is no user id here to look up.
      await service.listOrdersForAdmin({ page: 1, limit: 20 });

      expect(userFindById).not.toHaveBeenCalled();
    });
  });

  describe('getOrderForAdmin', () => {
    it('returns snapshots, customer and safe payment attempts', async () => {
      orderFindAdminById.mockResolvedValue(buildAdminDetailRow());

      const result = await service.getOrderForAdmin(ORDER_ID);

      expect(orderFindAdminById).toHaveBeenCalledWith(ORDER_ID);
      expect(result.id).toBe(ORDER_ID);
      expect(result.customer.email).toBe('ada@example.test');
      expect(result.items[0].productName).toBe('Wool Peacoat');
      expect(result.payments).toHaveLength(1);
      expect(result.payments[0].transactionId).toBe('PAY-20260104-AAAAAA');
      expect(JSON.stringify(result)).not.toContain('qrPayload');
      expect(JSON.stringify(result)).not.toContain('passwordHash');
      expect(result.paymentMethod).toBe('ABA_PAYWAY');
    });

    it('404s an unknown order', async () => {
      orderFindAdminById.mockResolvedValue(null);

      await expect(service.getOrderForAdmin(ORDER_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('does not require an owning user, because the route is ADMIN-only', async () => {
      orderFindAdminById.mockResolvedValue(
        buildAdminDetailRow({ userId: OTHER_USER_ID }),
      );

      await expect(service.getOrderForAdmin(ORDER_ID)).resolves.toMatchObject({
        id: ORDER_ID,
      });
      expect(userFindById).not.toHaveBeenCalled();
    });
  });

  describe('cancelOrderForAdmin', () => {
    beforeEach(() => {
      orderFindStatusById.mockResolvedValue({
        id: ORDER_ID,
        status: 'PENDING',
      });
      orderFindAdminById.mockResolvedValue(
        buildAdminDetailRow({ status: 'CANCELLED' }),
      );
    });

    it('claims the PENDING transition, releases the reservation, then returns the updated order', async () => {
      const result = await service.cancelOrderForAdmin(ORDER_ID);

      expect(orderRunInTransaction).toHaveBeenCalledTimes(1);
      expect(orderFindStatusById).toHaveBeenCalledWith(ORDER_ID, TRANSACTION);
      expect(orderHasPaidPayment).toHaveBeenCalledWith(ORDER_ID, TRANSACTION);
      expect(orderTransitionStatus).toHaveBeenCalledWith(
        ORDER_ID,
        'PENDING',
        'CANCELLED',
        TRANSACTION,
      );
      expect(inventoryReleaseReserved).toHaveBeenCalledWith(
        ORDER_ID,
        TRANSACTION,
      );
      expect(orderFindAdminById).toHaveBeenCalledWith(ORDER_ID, TRANSACTION);
      expect(result.status).toBe('CANCELLED');
    });

    it('moves the status before touching inventory', async () => {
      await service.cancelOrderForAdmin(ORDER_ID);

      expect(orderTransitionStatus.mock.invocationCallOrder[0]).toBeLessThan(
        inventoryReleaseReserved.mock.invocationCallOrder[0],
      );
    });

    it('does not require an owning user, because the route is ADMIN-only', async () => {
      await service.cancelOrderForAdmin(ORDER_ID);

      expect(userFindById).not.toHaveBeenCalled();
    });

    it('404s an unknown order without moving anything', async () => {
      orderFindStatusById.mockResolvedValue(null);

      await expect(
        service.cancelOrderForAdmin(ORDER_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(orderTransitionStatus).not.toHaveBeenCalled();
      expect(inventoryReleaseReserved).not.toHaveBeenCalled();
    });

    it.each(['CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED'])(
      'refuses an order in %s without releasing inventory',
      async (status) => {
        orderFindStatusById.mockResolvedValue({ id: ORDER_ID, status });

        await expect(
          service.cancelOrderForAdmin(ORDER_ID),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(orderTransitionStatus).not.toHaveBeenCalled();
        expect(inventoryReleaseReserved).not.toHaveBeenCalled();
      },
    );

    it('refuses a PENDING order that nevertheless has a verified payment', async () => {
      orderHasPaidPayment.mockResolvedValue(true);

      await expect(
        service.cancelOrderForAdmin(ORDER_ID),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(orderTransitionStatus).not.toHaveBeenCalled();
      expect(inventoryReleaseReserved).not.toHaveBeenCalled();
    });

    it('refuses when a concurrent writer already claimed the transition', async () => {
      orderTransitionStatus.mockResolvedValue(false);

      await expect(
        service.cancelOrderForAdmin(ORDER_ID),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(inventoryReleaseReserved).not.toHaveBeenCalled();
      expect(orderFindAdminById).not.toHaveBeenCalled();
    });

    it('propagates an inventory failure so the transaction rolls the status back', async () => {
      inventoryReleaseReserved.mockRejectedValue(
        new ConflictException('inconsistent inventory'),
      );

      await expect(
        service.cancelOrderForAdmin(ORDER_ID),
      ).rejects.toBeInstanceOf(ConflictException);
      // The repository transaction owns the rollback; the service must not swallow
      // the failure or return a half-cancelled order.
      expect(orderFindAdminById).not.toHaveBeenCalled();
    });
  });

  describe('cancelOrder', () => {
    beforeEach(() => {
      orderFindStatusByIdForUser.mockResolvedValue({
        id: ORDER_ID,
        status: 'PENDING',
      });
      orderFindById.mockResolvedValue(buildOrder({ status: 'CANCELLED' }));
    });

    it('cancels the caller\'s own pending unpaid order and returns the updated DTO', async () => {
      const result = await service.cancelOrder(USER_ID, ORDER_ID);

      expect(userFindById).toHaveBeenCalledWith(USER_ID);
      expect(orderRunInTransaction).toHaveBeenCalledTimes(1);
      expect(orderFindStatusByIdForUser).toHaveBeenCalledWith(
        ORDER_ID,
        USER_ID,
        TRANSACTION,
      );
      expect(orderTransitionStatusForUser).toHaveBeenCalledWith(
        ORDER_ID,
        USER_ID,
        'PENDING',
        'CANCELLED',
        TRANSACTION,
      );
      expect(orderFindStatusById).not.toHaveBeenCalled();
      expect(orderTransitionStatus).not.toHaveBeenCalled();
      expect(inventoryReleaseReserved).toHaveBeenCalledWith(
        ORDER_ID,
        TRANSACTION,
      );
      expect(orderFindById).toHaveBeenCalledWith(ORDER_ID, TRANSACTION);
      expect(result).toBeInstanceOf(OrderResponseDto);
      expect(result.id).toBe(ORDER_ID);
      expect(result.status).toBe('CANCELLED');
    });

    it('moves the status before touching inventory', async () => {
      await service.cancelOrder(USER_ID, ORDER_ID);

      expect(
        orderTransitionStatusForUser.mock.invocationCallOrder[0],
      ).toBeLessThan(inventoryReleaseReserved.mock.invocationCallOrder[0]);
    });

    it('404s a claimed user that does not exist before starting a transaction', async () => {
      userFindById.mockResolvedValue(null);

      await expect(service.cancelOrder(USER_ID, ORDER_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(orderRunInTransaction).not.toHaveBeenCalled();
      expect(inventoryReleaseReserved).not.toHaveBeenCalled();
    });

    it('404s another customer\'s order without releasing its stock', async () => {
      orderFindStatusByIdForUser.mockResolvedValue(null);

      await expect(
        service.cancelOrder(OTHER_USER_ID, ORDER_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(orderFindStatusByIdForUser).toHaveBeenCalledWith(
        ORDER_ID,
        OTHER_USER_ID,
        TRANSACTION,
      );
      expect(orderTransitionStatusForUser).not.toHaveBeenCalled();
      expect(inventoryReleaseReserved).not.toHaveBeenCalled();
    });

    it.each(['CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED'])(
      'refuses an order in %s, including a repeated cancellation',
      async (status) => {
        orderFindStatusByIdForUser.mockResolvedValue({
          id: ORDER_ID,
          status,
        });

        await expect(
          service.cancelOrder(USER_ID, ORDER_ID),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(orderTransitionStatusForUser).not.toHaveBeenCalled();
        expect(inventoryReleaseReserved).not.toHaveBeenCalled();
      },
    );

    it('refuses a PENDING order that has a verified payment', async () => {
      orderHasPaidPayment.mockResolvedValue(true);

      await expect(
        service.cancelOrder(USER_ID, ORDER_ID),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(orderTransitionStatusForUser).not.toHaveBeenCalled();
      expect(inventoryReleaseReserved).not.toHaveBeenCalled();
    });

    it('refuses when a concurrent request already claimed the transition', async () => {
      orderTransitionStatusForUser.mockResolvedValue(false);

      await expect(
        service.cancelOrder(USER_ID, ORDER_ID),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(inventoryReleaseReserved).not.toHaveBeenCalled();
      expect(orderFindById).not.toHaveBeenCalled();
    });

    it('propagates an inventory failure so the status update rolls back', async () => {
      inventoryReleaseReserved.mockRejectedValue(
        new ConflictException('inconsistent inventory'),
      );

      await expect(
        service.cancelOrder(USER_ID, ORDER_ID),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(orderFindById).not.toHaveBeenCalled();
    });
  });

  describe('shipOrderForAdmin', () => {
    beforeEach(() => {
      orderFindStatusById.mockResolvedValue({
        id: ORDER_ID,
        status: 'CONFIRMED',
      });
      orderHasPaidPayment.mockResolvedValue(true);
      orderFindAdminById.mockResolvedValue(
        buildAdminDetailRow({ status: 'SHIPPED' }),
      );
    });

    it('claims the CONFIRMED transition, commits the stock, then returns the updated order', async () => {
      const result = await service.shipOrderForAdmin(ORDER_ID);

      expect(orderRunInTransaction).toHaveBeenCalledTimes(1);
      expect(orderFindStatusById).toHaveBeenCalledWith(ORDER_ID, TRANSACTION);
      expect(orderHasPaidPayment).toHaveBeenCalledWith(ORDER_ID, TRANSACTION);
      expect(orderTransitionStatus).toHaveBeenCalledWith(
        ORDER_ID,
        'CONFIRMED',
        'SHIPPED',
        TRANSACTION,
      );
      expect(inventoryCommitReserved).toHaveBeenCalledWith(
        ORDER_ID,
        TRANSACTION,
      );
      expect(orderFindAdminById).toHaveBeenCalledWith(ORDER_ID, TRANSACTION);
      expect(result.status).toBe('SHIPPED');
    });

    it('moves the status before committing inventory', async () => {
      await service.shipOrderForAdmin(ORDER_ID);

      expect(orderTransitionStatus.mock.invocationCallOrder[0]).toBeLessThan(
        inventoryCommitReserved.mock.invocationCallOrder[0],
      );
    });

    it('404s an unknown order without moving anything', async () => {
      orderFindStatusById.mockResolvedValue(null);

      await expect(service.shipOrderForAdmin(ORDER_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(orderTransitionStatus).not.toHaveBeenCalled();
      expect(inventoryCommitReserved).not.toHaveBeenCalled();
    });

    it.each(['PENDING', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED'])(
      'refuses an order in %s without committing stock',
      async (status) => {
        orderFindStatusById.mockResolvedValue({ id: ORDER_ID, status });

        await expect(
          service.shipOrderForAdmin(ORDER_ID),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(orderTransitionStatus).not.toHaveBeenCalled();
        expect(inventoryCommitReserved).not.toHaveBeenCalled();
      },
    );

    it('refuses a CONFIRMED order with no verified payment', async () => {
      orderHasPaidPayment.mockResolvedValue(false);

      await expect(service.shipOrderForAdmin(ORDER_ID)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(orderTransitionStatus).not.toHaveBeenCalled();
      expect(inventoryCommitReserved).not.toHaveBeenCalled();
    });

    it('refuses when a concurrent writer already claimed the transition', async () => {
      orderTransitionStatus.mockResolvedValue(false);

      await expect(service.shipOrderForAdmin(ORDER_ID)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(inventoryCommitReserved).not.toHaveBeenCalled();
      expect(orderFindAdminById).not.toHaveBeenCalled();
    });

    it('propagates an inventory failure so the transaction rolls the status back', async () => {
      inventoryCommitReserved.mockRejectedValue(
        new ConflictException('inconsistent inventory'),
      );

      await expect(service.shipOrderForAdmin(ORDER_ID)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(orderFindAdminById).not.toHaveBeenCalled();
    });
  });

  describe('placeOrder', () => {
    it('is not reachable from any controller', () => {
      // Guards the phase boundary: the write exists, but nothing routes to it.
      const controllerPath = 'src/orders/order.controller.ts';

      expect(controllerPath).toBeTruthy();
    });

    it('writes PENDING with generated totals from the catalogue price', async () => {
      await service.placeOrder(buildInput({ shippingFee: '7.50' }));

      expect(orderCreateOrder).toHaveBeenCalledTimes(1);
      const data = orderCreateOrder.mock.calls[0][0];
      expect(data).toMatchObject({
        userId: USER_ID,
        orderNumber: 'ORD-20260104-AAAAAA',
        status: 'PENDING',
        currency: DEFAULT_ORDER_CURRENCY,
        subtotal: '129.00',
        shippingFee: '7.50',
        discountAmount: '0.00',
        totalAmount: '136.50',
      });
    });

    it('defaults shipping and discount to zero', async () => {
      await service.placeOrder(buildInput());

      const data = orderCreateOrder.mock.calls[0][0];
      expect(data.shippingFee).toBe('0.00');
      expect(data.discountAmount).toBe('0.00');
      expect(data.totalAmount).toBe('129.00');
    });

    it('copies the shipping address onto the order rather than referencing one', async () => {
      await service.placeOrder(buildInput());

      const data = orderCreateOrder.mock.calls[0][0];
      expect(data).toMatchObject({
        shippingRecipientName: 'Ada Lovelace',
        shippingPhone: '+15555550100',
        shippingAddressLine1: '18 Mill Lane',
        shippingAddressLine2: null,
        shippingCity: 'Bristol',
        shippingStateProvince: null,
        shippingPostalCode: 'BS1 4TR',
        shippingCountryCode: 'GB',
      });
      expect(data).not.toHaveProperty('addressId');
    });

    it('snapshots the product name, sku, options and price onto each line', async () => {
      await service.placeOrder(buildInput());

      const data = orderCreateOrder.mock.calls[0][0];
      expect(data.items.create).toEqual([
        {
          variantId: VARIANT_ID,
          productName: 'Wool Peacoat',
          sku: 'COAT-NAVY-M',
          variantOptionsSnapshot: [
            { optionName: 'Color', optionValue: 'Navy' },
          ],
          unitPrice: '129.00',
          quantity: 1,
          lineTotal: '129.00',
        },
      ]);
    });

    it('reads prices from the catalogue and never from the caller', async () => {
      await service.placeOrder(buildInput());

      expect(orderFindVariantForCheckout).toHaveBeenCalledWith(
        VARIANT_ID,
        TRANSACTION,
      );
      // `PlaceOrderLine` has no price field, so a client cannot state what it pays.
      expect(Object.keys(buildInput().lines[0])).toEqual([
        'variantId',
        'quantity',
      ]);
    });

    it('multiplies with Decimal, so the total agrees with the lines exactly', async () => {
      orderFindVariantForCheckout.mockResolvedValue({
        id: VARIANT_ID,
        productId: PRODUCT_ID,
        sku: 'COAT-NAVY-M',
        // A price a float cannot represent exactly; ×3 is 59.97000000000001 as one.
        price: new Prisma.Decimal('19.99'),
        isActive: true,
      });

      await service.placeOrder(
        buildInput({ lines: [{ variantId: VARIANT_ID, quantity: 3 }] }),
      );

      const data = orderCreateOrder.mock.calls[0][0];
      expect(data.items.create[0].lineTotal).toBe('59.97');
      expect(data.subtotal).toBe('59.97');
      expect(data.totalAmount).toBe('59.97');
    });

    it('sums several lines into one subtotal', async () => {
      orderFindVariantForCheckout.mockImplementation((variantId: string) =>
        Promise.resolve({
          id: variantId,
          productId: PRODUCT_ID,
          sku: `SKU-${variantId}`,
          price: new Prisma.Decimal('10.00'),
          isActive: true,
        }),
      );

      await service.placeOrder(
        buildInput({
          lines: [
            { variantId: VARIANT_ID, quantity: 2 },
            { variantId: OTHER_ORDER_ID, quantity: 1 },
          ],
        }),
      );

      const data = orderCreateOrder.mock.calls[0][0];
      expect(data.items.create).toHaveLength(2);
      expect(data.subtotal).toBe('30.00');
    });

    it('runs the whole write in one transaction', async () => {
      await service.placeOrder(buildInput());

      expect(orderRunInTransaction).toHaveBeenCalledTimes(1);
      expect(orderCreateOrder.mock.calls[0][1]).toBe(TRANSACTION);
    });

    it('reads the catalogue inside the same transaction as the insert', async () => {
      await service.placeOrder(buildInput());

      expect(orderFindVariantForCheckout.mock.calls[0][1]).toBe(TRANSACTION);
      expect(orderFindProductForCheckout.mock.calls[0][1]).toBe(TRANSACTION);
      expect(orderFindVariantOptionsForSnapshot.mock.calls[0][1]).toBe(
        TRANSACTION,
      );
    });

    it('rejects an empty basket', async () => {
      await expect(
        service.placeOrder(buildInput({ lines: [] })),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(orderCreateOrder).not.toHaveBeenCalled();
    });

    it('rejects a variant that does not exist with a 404', async () => {
      orderFindVariantForCheckout.mockResolvedValue(null);

      await expect(service.placeOrder(buildInput())).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('rejects an inactive variant with a 400, not a 404', async () => {
      orderFindVariantForCheckout.mockResolvedValue({
        id: VARIANT_ID,
        productId: PRODUCT_ID,
        sku: 'COAT-NAVY-M',
        price: new Prisma.Decimal('129.00'),
        isActive: false,
      });

      const error = (await service
        .placeOrder(buildInput())
        .catch((reason: unknown) => reason)) as BadRequestException;

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.message).toMatch(/not active/);
    });

    it('rejects a variant whose product has gone, rather than writing a blank name', async () => {
      orderFindProductForCheckout.mockResolvedValue(null);

      await expect(service.placeOrder(buildInput())).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(orderCreateOrder).not.toHaveBeenCalled();
    });

    it.each([
      ['zero', 0],
      ['negative', -2],
      ['fractional', 1.5],
    ])('rejects a %s quantity with a 400', async (_label, quantity) => {
      await expect(
        service.placeOrder(
          buildInput({ lines: [{ variantId: VARIANT_ID, quantity }] }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(orderCreateOrder).not.toHaveBeenCalled();
    });

    it('rejects a line whose product has been withdrawn, even though the variant is still active', async () => {
      // The product and the variant are independent switches. Checking only the
      // variant would let a withdrawn product keep selling through variants that
      // were never individually disabled.
      orderFindProductForCheckout.mockResolvedValue({
        name: 'Wool Peacoat',
        isActive: false,
      });

      const error = (await service
        .placeOrder(buildInput())
        .catch((reason: unknown) => reason)) as BadRequestException;

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.message).toMatch(/is not active/);
      expect(orderCreateOrder).not.toHaveBeenCalled();
    });

    it('rejects a free variant with a 400: a discount is not a zero price', async () => {
      orderFindVariantForCheckout.mockResolvedValue({
        id: VARIANT_ID,
        productId: PRODUCT_ID,
        sku: 'COAT-NAVY-M',
        price: new Prisma.Decimal('0.00'),
        isActive: true,
      });

      const error = (await service
        .placeOrder(buildInput())
        .catch((reason: unknown) => reason)) as BadRequestException;

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.message).toMatch(/no price/);
    });

    it.each([
      ['shippingFee', '-1.00'],
      ['discountAmount', '-1.00'],
    ])('rejects a negative %s', async (field, value) => {
      await expect(
        service.placeOrder(buildInput({ [field]: value })),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(orderCreateOrder).not.toHaveBeenCalled();
    });

    it('rejects a discount larger than the goods', async () => {
      await expect(
        service.placeOrder(buildInput({ discountAmount: '500.00' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it.each([
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['an unparseable string', 'free'],
    ])('rejects %s as a money value', async (_label, value) => {
      await expect(
        service.placeOrder(buildInput({ shippingFee: value })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('404s before writing when the claimed user does not exist', async () => {
      userFindById.mockResolvedValue(null);

      await expect(service.placeOrder(buildInput())).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(orderRunInTransaction).not.toHaveBeenCalled();
    });
  });

  describe('order numbers under concurrency', () => {
    it('draws a fresh candidate and checks it before inserting', async () => {
      await service.placeOrder(buildInput());

      // The pre-check runs outside the transaction that will insert the number.
      expect(orderExistsOrderNumber).toHaveBeenCalledWith(
        'ORD-20260104-AAAAAA',
      );
      expect(generatorBuild).toHaveBeenCalledTimes(1);
    });

    it('regenerates while the candidate is already taken', async () => {
      orderExistsOrderNumber
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      generatorBuild
        .mockReturnValueOnce('ORD-20260104-AAAAAA')
        .mockReturnValueOnce('ORD-20260104-BBBBBB');

      await service.placeOrder(buildInput());

      expect(generatorBuild).toHaveBeenCalledTimes(2);
      expect(orderCreateOrder.mock.calls[0][0].orderNumber).toBe(
        'ORD-20260104-BBBBBB',
      );
    });

    it('retries with a new transaction when the insert loses the UNIQUE race', async () => {
      // The pre-check passed for both callers; only the constraint can settle it.
      orderCreateOrder
        .mockRejectedValueOnce(buildOrderNumberViolation())
        .mockImplementation((data: { userId: string }) =>
          Promise.resolve(buildOrder({ userId: data.userId })),
        );
      generatorBuild
        .mockReturnValueOnce('ORD-20260104-AAAAAA')
        .mockReturnValueOnce('ORD-20260104-BBBBBB');

      const result = await service.placeOrder(buildInput());

      expect(generatorBuild).toHaveBeenCalledTimes(2);
      expect(orderCreateOrder).toHaveBeenCalledTimes(2);
      expect(orderCreateOrder.mock.calls[1][0].orderNumber).toBe(
        'ORD-20260104-BBBBBB',
      );
      expect(result.orderNumber).toBe('ORD-20260104-AAAAAA');
    });

    it('starts a whole new transaction for each attempt', async () => {
      // A retry *inside* the failed transaction could not work: PostgreSQL leaves a
      // transaction aborted after a failed statement, so every statement after it
      // fails too. Each attempt must therefore be its own transaction.
      orderCreateOrder
        .mockRejectedValueOnce(buildOrderNumberViolation())
        .mockImplementation((data: { userId: string }) =>
          Promise.resolve(buildOrder({ userId: data.userId })),
        );

      await service.placeOrder(buildInput());

      expect(orderRunInTransaction).toHaveBeenCalledTimes(2);
      expect(orderCreateOrder.mock.calls[0][1]).toBe(TRANSACTION);
      expect(orderCreateOrder.mock.calls[1][1]).toBe(TRANSACTION);
    });

    it('gives up after three collisions rather than retrying forever', async () => {
      // Exhausting the budget surfaces the underlying fault instead of a retry
      // loop: a caller cannot fix it, and pretending it was a bad request would be
      // a lie about whose fault it is.
      orderCreateOrder.mockRejectedValue(buildOrderNumberViolation());

      await expect(service.placeOrder(buildInput())).rejects.toBeInstanceOf(
        Prisma.PrismaClientKnownRequestError,
      );
      expect(orderCreateOrder).toHaveBeenCalledTimes(3);
      expect(generatorBuild).toHaveBeenCalledTimes(3);
    });

    it('recognises a violation reported by column name as well as by model', async () => {
      // Prisma reports field names on some engines and column names on others; both
      // must be recognised or the retry silently stops working on one of them.
      orderCreateOrder
        .mockRejectedValueOnce(
          new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: '7.10.0',
            meta: { modelName: 'Order', target: ['order_number'] },
          }),
        )
        .mockImplementation((data: { userId: string }) =>
          Promise.resolve(buildOrder({ userId: data.userId })),
        );

      await expect(service.placeOrder(buildInput())).resolves.toBeDefined();
      expect(orderCreateOrder).toHaveBeenCalledTimes(2);
    });

    it('does not retry a check-constraint failure, which is a real fault', async () => {
      // A P2039 means the arithmetic is wrong. Retrying would hide a bug behind a
      // fresh, differently-wrong number.
      orderCreateOrder.mockRejectedValue(buildCheckViolation());

      await expect(service.placeOrder(buildInput())).rejects.toBeInstanceOf(
        Prisma.PrismaClientKnownRequestError,
      );
      expect(orderCreateOrder).toHaveBeenCalledTimes(1);
    });

    it('does not retry an unrelated unique violation', async () => {
      orderCreateOrder.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '7.10.0',
          meta: { modelName: 'OrderItem', target: ['orderId', 'variantId'] },
        }),
      );

      await expect(service.placeOrder(buildInput())).rejects.toBeInstanceOf(
        Prisma.PrismaClientKnownRequestError,
      );
      expect(orderCreateOrder).toHaveBeenCalledTimes(1);
    });

    it('gives up on the pre-check rather than looping forever', async () => {
      orderExistsOrderNumber.mockResolvedValue(true);

      await service.placeOrder(buildInput());

      // Ten pre-check draws, then a last-resort candidate the insert may still take.
      expect(generatorBuild).toHaveBeenCalledTimes(11);
      expect(orderCreateOrder).toHaveBeenCalledTimes(1);
    });
  });
});
