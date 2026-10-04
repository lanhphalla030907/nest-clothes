import { Test, TestingModule } from '@nestjs/testing';
import type { Mock } from 'vitest';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  OrderRepository,
  type CreateOrderData,
} from './order.repository.js';

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
        variantOptionsSnapshot: [
          { optionName: 'Color', optionValue: 'Navy' },
        ],
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
    order: { findUnique: Mock; findMany: Mock; create: Mock };
    productVariant: { findUnique: Mock };
    product: { findUnique: Mock };
    variantOption: { findMany: Mock };
    $transaction: Mock<(work: (tx: never) => Promise<unknown>) => Promise<unknown>>;
  };

  beforeEach(async () => {
    prisma = {
      order: {
        findUnique: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue(null),
      },
      productVariant: { findUnique: vi.fn().mockResolvedValue(null) },
      product: { findUnique: vi.fn().mockResolvedValue(null) },
      variantOption: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: vi.fn<(work: (tx: never) => Promise<unknown>) => Promise<unknown>>(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrderRepository,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    repository = module.get(OrderRepository);
    prisma.$transaction.mockImplementation((work) =>
      (work as (tx: unknown) => Promise<unknown>)(TRANSACTION),
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
        { code: 'P2002', clientVersion: '7.10.0', meta: { modelName: 'Order' } },
      );
      prisma.order.create.mockRejectedValue(violation);

      await expect(
        repository.createOrder(buildCreateData()),
      ).rejects.toBe(violation);
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
      await repository.findVariantOptionsForSnapshot(VARIANT_ID, prisma as never);

      expect(prisma.variantOption.findMany).toHaveBeenCalledWith({
        where: { variantId: VARIANT_ID },
        orderBy: [{ optionName: 'asc' }, { id: 'asc' }],
        select: { optionName: true, optionValue: true },
      });
    });
  });
});
