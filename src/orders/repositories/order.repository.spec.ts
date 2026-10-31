import { Test, TestingModule } from '@nestjs/testing';
import type { Mock } from 'vitest';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { OrderRepository, type CreateOrderData } from './order.repository.js';

const USER_ID = 'a1b2c3d4-e5f6-4f70-8a9b-0c1d2e3f4a5b';
const ORDER_ID = 'c3d4e5f6-a7b8-4c92-8d1e-2f3a4b5c6d7e';
const VARIANT_ID = 'e5f6a7b8-c9d0-4eb4-af30-4b5c6d7e8f90';
const PRODUCT_ID = 'f6a7b8c9-d0e1-4fc5-b041-5c6d7e8f9012';
const TRANSACTION = { tag: 'tx' } as never;

const buildCreateData = (
  overrides: Partial<CreateOrderData> = {},
): CreateOrderData => ({
  userId: USER_ID,
  orderNumber: 'ORD-20260104-AAAAAA',
  status: 'PENDING',
  subtotal: '129.00',
  shippingFee: '7.50',
  discountAmount: '8.00',
  totalAmount: '128.50',
  currency: 'USD',
  shippingRecipientName: 'Ada Lovelace',
  shippingPhone: '+15555550100',
  shippingAddressLine1: '18 Mill Lane',
  shippingAddressLine2: null,
  shippingCity: 'Bristol',
  shippingStateProvince: null,
  shippingPostalCode: 'BS1 4TR',
  shippingCountryCode: 'GB',
  items: {
    create: [
      {
        variantId: VARIANT_ID,
        productName: 'Wool Peacoat',
        sku: 'COAT-NAVY-M',
        variantOptionsSnapshot: [{ optionName: 'Color', optionValue: 'Navy' }],
        unitPrice: '129.00',
        quantity: 1,
        lineTotal: '129.00',
      },
    ],
  },
  ...overrides,
});

/**
 * These assertions are about *query shape*, not results: the arguments each method
 * hands to Prisma are what decide whether an order read can leak a live catalogue
 * row, whether the listing can be served from an index, and whether an insert can
 * leave an order without its lines. A behavioural mock of the service cannot see any
 * of that, so it is pinned here.
 */
describe('OrderRepository', () => {
  let repository: OrderRepository;
  let prisma: {
    order: {
      findUnique: Mock;
      findFirst: Mock;
      findMany: Mock;
      create: Mock;
      count: Mock;
      updateMany: Mock;
    };
    orderItem: { findMany: Mock };
    productVariant: { findUnique: Mock };
    product: { findUnique: Mock };
    variantOption: { findMany: Mock };
    payment: { count: Mock };
    $transaction: Mock;
  };

  beforeEach(async () => {
    prisma = {
      order: {
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue(null),
        count: vi.fn().mockResolvedValue(0),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      orderItem: { findMany: vi.fn().mockResolvedValue([]) },
      productVariant: { findUnique: vi.fn().mockResolvedValue(null) },
      product: { findUnique: vi.fn().mockResolvedValue(null) },
      variantOption: { findMany: vi.fn().mockResolvedValue([]) },
      payment: { count: vi.fn().mockResolvedValue(0) },
      $transaction: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrderRepository,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    repository = module.get(OrderRepository);
    prisma.$transaction.mockImplementation(
      (input: ((tx: unknown) => Promise<unknown>) | Promise<unknown>[]) =>
        typeof input === 'function' ? input(TRANSACTION) : Promise.all(input),
    );
  });

  describe('runInTransaction', () => {
    it('hands the work a client bound to the transaction', async () => {
      const result = await repository.runInTransaction(async (tx) => {
        expect(tx).toBe(TRANSACTION);
        return 'done';
      });

      expect(result).toBe('done');
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('propagates a rejection so the transaction rolls back', async () => {
      await expect(
        repository.runInTransaction(async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
    });
  });

  describe('findById', () => {
    it('reads one order with its items and nothing else', async () => {
      await repository.findById(ORDER_ID);

      expect(prisma.order.findUnique).toHaveBeenCalledWith({
        where: { id: ORDER_ID },
        include: {
          items: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
        },
      });
    });

    it('never selects the user or the variant relation', async () => {
      await repository.findById(ORDER_ID);

      const call = prisma.order.findUnique.mock.calls[0][0] as {
        include: { user?: unknown; items: { include?: unknown } };
      };

      // Joining `variant` would let a later rename or repricing rewrite what a
      // placed order says; joining `user` would put `passwordHash` in memory.
      expect(call.include.user).toBeUndefined();
      expect(call.include.items.include).toBeUndefined();
    });

    it('does not filter by owner, so the service can apply one 404 for both cases', async () => {
      await repository.findById(ORDER_ID);

      expect(prisma.order.findUnique.mock.calls[0][0]).toMatchObject({
        where: { id: ORDER_ID },
      });
    });

    it('uses a supplied transaction client when given one', async () => {
      const client = { order: { findUnique: vi.fn() } };

      await repository.findById(ORDER_ID, client as never);

      expect(client.order.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.order.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('findStatusById', () => {
    it('selects only the key and current status', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: ORDER_ID,
        status: 'PENDING',
      });

      const result = await repository.findStatusById(ORDER_ID);

      expect(prisma.order.findUnique).toHaveBeenCalledWith({
        where: { id: ORDER_ID },
        select: { id: true, status: true },
      });
      expect(result).toEqual({ id: ORDER_ID, status: 'PENDING' });
    });

    it('uses the supplied transaction client', async () => {
      const client = { order: { findUnique: vi.fn().mockResolvedValue(null) } };

      await repository.findStatusById(ORDER_ID, client as never);

      expect(client.order.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.order.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('findStatusByIdForUser', () => {
    it('puts ownership in the WHERE clause and selects only the key and status', async () => {
      prisma.order.findFirst.mockResolvedValue({
        id: ORDER_ID,
        status: 'PENDING',
      });

      const result = await repository.findStatusByIdForUser(ORDER_ID, USER_ID);

      expect(prisma.order.findFirst).toHaveBeenCalledWith({
        where: { id: ORDER_ID, userId: USER_ID },
        select: { id: true, status: true },
      });
      expect(result).toEqual({ id: ORDER_ID, status: 'PENDING' });
    });

    it('returns null for an order owned by somebody else', async () => {
      prisma.order.findFirst.mockResolvedValue(null);

      await expect(
        repository.findStatusByIdForUser(ORDER_ID, USER_ID),
      ).resolves.toBeNull();
    });

    it('uses the supplied transaction client', async () => {
      const client = { order: { findFirst: vi.fn().mockResolvedValue(null) } };

      await repository.findStatusByIdForUser(
        ORDER_ID,
        USER_ID,
        client as never,
      );

      expect(client.order.findFirst).toHaveBeenCalledTimes(1);
      expect(prisma.order.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('findByUserId', () => {
    it('scopes to the user and orders newest first', async () => {
      await repository.findByUserId(USER_ID);

      expect(prisma.order.findMany).toHaveBeenCalledWith({
        where: { userId: USER_ID },
        include: {
          items: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
        },
        // Column-for-column the same as `orders_user_id_created_at_id_idx`, so the
        // listing is an index walk rather than a sort.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
    });

    it('has no pagination, because this phase defines none', async () => {
      await repository.findByUserId(USER_ID);

      const call = prisma.order.findMany.mock.calls[0][0] as Record<
        string,
        unknown
      >;

      expect(call).not.toHaveProperty('take');
      expect(call).not.toHaveProperty('cursor');
      expect(call).not.toHaveProperty('skip');
    });
  });

  describe('findItemQuantitiesByOrderId', () => {
    it('reads only the persisted variant/quantity pairs for the order', async () => {
      prisma.orderItem.findMany.mockResolvedValue([
        { variantId: VARIANT_ID, quantity: 2 },
      ]);

      const result = await repository.findItemQuantitiesByOrderId(ORDER_ID);

      expect(prisma.orderItem.findMany).toHaveBeenCalledWith({
        where: { orderId: ORDER_ID },
        select: { variantId: true, quantity: true },
      });
      expect(result).toEqual([{ variantId: VARIANT_ID, quantity: 2 }]);
    });

    it('uses the supplied transaction client, never the default one', async () => {
      const client = { orderItem: { findMany: vi.fn().mockResolvedValue([]) } };

      await repository.findItemQuantitiesByOrderId(ORDER_ID, client as never);

      expect(client.orderItem.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.orderItem.findMany).not.toHaveBeenCalled();
    });
  });

  describe('findByOrderNumber', () => {
    it('reads by the unique order number', async () => {
      await repository.findByOrderNumber('ORD-20260104-AAAAAA');

      expect(prisma.order.findMany).not.toHaveBeenCalled();
      expect(prisma.order.findUnique).toHaveBeenCalledWith({
        where: { orderNumber: 'ORD-20260104-AAAAAA' },
        include: {
          items: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
        },
      });
    });
  });

  describe('existsOrderNumber', () => {
    it('reports false when the number is free', async () => {
      prisma.order.findUnique.mockResolvedValue(null);

      await expect(repository.existsOrderNumber('ORD-1')).resolves.toBe(false);
    });

    it('reports true when the number is taken', async () => {
      prisma.order.findUnique.mockResolvedValue({ id: ORDER_ID });

      await expect(repository.existsOrderNumber('ORD-1')).resolves.toBe(true);
    });

    it('selects only the key, so the check transfers no row data', async () => {
      await repository.existsOrderNumber('ORD-1');

      expect(prisma.order.findUnique).toHaveBeenCalledWith({
        where: { orderNumber: 'ORD-1' },
        select: { id: true },
      });
    });
  });

  describe('transitionStatus', () => {
    it('guards the source status in the WHERE clause and reports a claim', async () => {
      prisma.order.updateMany.mockResolvedValue({ count: 1 });

      const result = await repository.transitionStatus(
        ORDER_ID,
        'PENDING',
        'CANCELLED',
      );

      expect(result).toBe(true);
      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: ORDER_ID, status: 'PENDING' },
        data: { status: 'CANCELLED' },
      });
    });

    it('reports a lost race when no row still has the expected status', async () => {
      prisma.order.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        repository.transitionStatus(ORDER_ID, 'PENDING', 'CANCELLED'),
      ).resolves.toBe(false);
    });

    it('uses the supplied transaction client', async () => {
      const client = {
        order: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      };

      await repository.transitionStatus(
        ORDER_ID,
        'CONFIRMED',
        'SHIPPED',
        client as never,
      );

      expect(client.order.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('transitionStatusForUser', () => {
    it('guards both ownership and the source status in the WHERE clause', async () => {
      prisma.order.updateMany.mockResolvedValue({ count: 1 });

      const result = await repository.transitionStatusForUser(
        ORDER_ID,
        USER_ID,
        'PENDING',
        'CANCELLED',
      );

      expect(result).toBe(true);
      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: ORDER_ID, userId: USER_ID, status: 'PENDING' },
        data: { status: 'CANCELLED' },
      });
    });

    it('reports a lost race or a different owner as no claim', async () => {
      prisma.order.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        repository.transitionStatusForUser(
          ORDER_ID,
          USER_ID,
          'PENDING',
          'CANCELLED',
        ),
      ).resolves.toBe(false);
    });

    it('uses the supplied transaction client', async () => {
      const client = {
        order: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      };

      await repository.transitionStatusForUser(
        ORDER_ID,
        USER_ID,
        'PENDING',
        'CANCELLED',
        client as never,
      );

      expect(client.order.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('hasPaidPayment', () => {
    it('counts only verified PAID attempts for the order', async () => {
      prisma.payment.count.mockResolvedValue(1);

      await expect(repository.hasPaidPayment(ORDER_ID)).resolves.toBe(true);
      expect(prisma.payment.count).toHaveBeenCalledWith({
        where: { orderId: ORDER_ID, status: 'PAID' },
      });
    });

    it('reports false when no attempt has been verified', async () => {
      prisma.payment.count.mockResolvedValue(0);

      await expect(repository.hasPaidPayment(ORDER_ID)).resolves.toBe(false);
    });

    it('uses the supplied transaction client', async () => {
      const client = { payment: { count: vi.fn().mockResolvedValue(1) } };

      await expect(
        repository.hasPaidPayment(ORDER_ID, client as never),
      ).resolves.toBe(true);
      expect(prisma.payment.count).not.toHaveBeenCalled();
    });
  });

  describe('createOrder', () => {
    it('inserts the order and its lines in one nested statement', async () => {
      await repository.createOrder(buildCreateData());

      // A two-step insert would leave a window in which a reader could see an order
      // with no lines — a financial record with no contents.
      expect(prisma.order.create).toHaveBeenCalledTimes(1);
      expect(prisma.order.create.mock.calls[0][0].data.items).toEqual({
        create: [
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
        ],
      });
    });

    it('hydrates the created order with its items', async () => {
      await repository.createOrder(buildCreateData());

      expect(prisma.order.create.mock.calls[0][0].include).toEqual({
        items: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      });
    });

    it('writes a plain userId scalar, never a nested connect', async () => {
      await repository.createOrder(buildCreateData());

      const data = prisma.order.create.mock.calls[0][0].data as Record<
        string,
        unknown
      >;

      expect(data.userId).toBe(USER_ID);
      expect(data).not.toHaveProperty('user');
    });

    it('forwards a unique violation so the caller can regenerate', async () => {
      const violation = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed',
        {
          code: 'P2002',
          clientVersion: '7.10.0',
          meta: { modelName: 'Order' },
        },
      );
      prisma.order.create.mockRejectedValue(violation);

      await expect(repository.createOrder(buildCreateData())).rejects.toBe(
        violation,
      );
    });

    it('writes through a supplied transaction client when given one', async () => {
      const client = { order: { create: vi.fn().mockResolvedValue(null) } };

      await repository.createOrder(buildCreateData(), client as never);

      expect(client.order.create).toHaveBeenCalledTimes(1);
      expect(prisma.order.create).not.toHaveBeenCalled();
    });
  });

  describe('findVariantForCheckout', () => {
    it('selects only the columns a snapshot line needs', async () => {
      await repository.findVariantForCheckout(VARIANT_ID, prisma as never);

      expect(prisma.productVariant.findUnique).toHaveBeenCalledWith({
        where: { id: VARIANT_ID },
        // A narrower projection is what stops a future column — a cost price, an
        // internal flag — reaching an order line by accident.
        select: {
          id: true,
          productId: true,
          sku: true,
          price: true,
          isActive: true,
        },
      });
    });

    it('reads through the transaction client it is given, never the default one', async () => {
      const client = { productVariant: { findUnique: vi.fn() } };

      await repository.findVariantForCheckout(VARIANT_ID, client as never);

      expect(client.productVariant.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.productVariant.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('findProductForCheckout', () => {
    it('selects only the name and whether it is still on sale', async () => {
      // The name is the snapshot; `isActive` is the sellability check. Nothing else
      // is read, so a future catalogue column cannot leak into an order line.
      await repository.findProductForCheckout(PRODUCT_ID, prisma as never);

      expect(prisma.product.findUnique).toHaveBeenCalledWith({
        where: { id: PRODUCT_ID },
        select: { name: true, isActive: true },
      });
    });
  });

  describe('findVariantOptionsForSnapshot', () => {
    it('orders options deterministically, so two snapshots are identical', async () => {
      await repository.findVariantOptionsForSnapshot(
        VARIANT_ID,
        prisma as never,
      );

      expect(prisma.variantOption.findMany).toHaveBeenCalledWith({
        where: { variantId: VARIANT_ID },
        orderBy: [{ optionName: 'asc' }, { id: 'asc' }],
        select: { optionName: true, optionValue: true },
      });
    });
  });

  describe('findAdminPage', () => {
    beforeEach(() => {
      prisma.order.findMany.mockResolvedValue([{ id: ORDER_ID }]);
      prisma.order.count.mockResolvedValue(1);
    });

    it('pages globally, newest first, and reads the total in the same transaction', async () => {
      const result = await repository.findAdminPage({ page: 3, limit: 10 });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.order.findMany).toHaveBeenCalledWith({
        where: {},
        select: expect.objectContaining({
          id: true,
          orderNumber: true,
          status: true,
          paymentMethod: true,
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
            },
          },
        }),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: 20,
        take: 10,
      });
      // The count must describe exactly the page's filters.
      expect(prisma.order.count).toHaveBeenCalledWith({ where: {} });
      expect(result).toEqual({ items: [{ id: ORDER_ID }], total: 1 });
    });

    it('combines status and inclusive date bounds in one where clause', async () => {
      const createdFrom = new Date('2026-01-01T00:00:00.000Z');
      const createdTo = new Date('2026-01-31T23:59:59.000Z');

      await repository.findAdminPage({
        page: 1,
        limit: 20,
        status: 'CONFIRMED',
        createdFrom,
        createdTo,
      });

      const expected = {
        status: 'CONFIRMED',
        createdAt: { gte: createdFrom, lte: createdTo },
      };

      expect(prisma.order.findMany.mock.calls[0][0].where).toEqual(expected);
      expect(prisma.order.count).toHaveBeenCalledWith({ where: expected });
    });

    it('searches the order number prefix and the customer fields', async () => {
      await repository.findAdminPage({
        page: 1,
        limit: 20,
        search: 'ada',
      });

      expect(prisma.order.findMany.mock.calls[0][0].where).toEqual({
        OR: [
          {
            orderNumber: {
              startsWith: 'ada',
              mode: 'insensitive',
            },
          },
          {
            user: {
              is: {
                firstName: { contains: 'ada', mode: 'insensitive' },
              },
            },
          },
          {
            user: {
              is: {
                lastName: { contains: 'ada', mode: 'insensitive' },
              },
            },
          },
          {
            user: {
              is: {
                email: { contains: 'ada', mode: 'insensitive' },
              },
            },
          },
        ],
      });
    });

    it('escapes LIKE wildcards so search matches them literally', async () => {
      await repository.findAdminPage({
        page: 1,
        limit: 20,
        search: 'a%b_c\\d',
      });

      const where = prisma.order.findMany.mock.calls[0][0].where as {
        OR: Array<{ orderNumber: { startsWith: string } }>;
      };

      expect(where.OR[0].orderNumber.startsWith).toBe('a\\%b\\_c\\\\d');
    });

    it('never selects credential or QR columns', async () => {
      await repository.findAdminPage({ page: 1, limit: 20 });

      const select = prisma.order.findMany.mock.calls[0][0].select as {
        user: { select: Record<string, boolean> };
        payments: { select: Record<string, boolean> };
      };

      expect(select.user.select).not.toHaveProperty('passwordHash');
      expect(select.payments.select).not.toHaveProperty('qrPayload');
      // The listing reads only quantities from the lines, not live catalogue data.
      expect(prisma.order.findMany.mock.calls[0][0].select.items).toEqual({
        select: { quantity: true },
      });
    });
  });

  describe('findAdminById', () => {
    it('reads one order with safe customer, snapshot items and safe payments', async () => {
      prisma.order.findUnique.mockResolvedValue({ id: ORDER_ID });

      const result = await repository.findAdminById(ORDER_ID);

      expect(result).toEqual({ id: ORDER_ID });
      expect(prisma.order.findUnique).toHaveBeenCalledWith({
        where: { id: ORDER_ID },
        select: expect.objectContaining({
          id: true,
          userId: true,
          orderNumber: true,
          status: true,
          paymentMethod: true,
          shippingAddressLine1: true,
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
            },
          },
        }),
      });

      const call = prisma.order.findUnique.mock.calls[0][0] as {
        select: {
          user: { select: Record<string, boolean> };
          payments: { select: Record<string, boolean> };
          items: { select: Record<string, boolean> };
          variant?: unknown;
        };
      };

      expect(call.select.user.select).not.toHaveProperty('passwordHash');
      expect(call.select.payments.select).not.toHaveProperty('qrPayload');
      // Items are read from their own snapshot columns; no `variant` relation is
      // joined, so a later rename cannot rewrite the receipt.
      expect(call.select.variant).toBeUndefined();
      expect(call.select.items.select.productName).toBe(true);
      expect(call.select.items.select.unitPrice).toBe(true);
    });

    it('returns null for an unknown order', async () => {
      prisma.order.findUnique.mockResolvedValue(null);

      await expect(repository.findAdminById(ORDER_ID)).resolves.toBeNull();
    });

    it('can read through a transaction client for a post-write response', async () => {
      const client = { order: { findUnique: vi.fn().mockResolvedValue(null) } };

      await repository.findAdminById(ORDER_ID, client as never);

      expect(client.order.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.order.findUnique).not.toHaveBeenCalled();
    });
  });
});
