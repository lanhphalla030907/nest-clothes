import { ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import type { Mock } from 'vitest';
import type { Inventory } from '../generated/prisma/client.js';
import { InventoryRepository } from '../inventory/repositories/inventory.repository.js';
import { OrderInventoryService } from './order-inventory.service.js';
import {
  OrderRepository,
  type OrderTransactionClient,
} from './repositories/order.repository.js';

const ORDER_ID = 'c3d4e5f6-a7b8-4c92-8d1e-2f3a4b5c6d7e';
const VARIANT_A = '11111111-1111-4111-8111-111111111111';
const VARIANT_B = '22222222-2222-4222-8222-222222222222';
const TRANSACTION = { tag: 'tx' } as unknown as OrderTransactionClient;

const buildInventory = (
  variantId: string,
  quantity = 10,
  reservedQuantity = 5,
): Inventory => ({
  id: `inventory-${variantId}`,
  variantId,
  quantity,
  reservedQuantity,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
});

/**
 * The rules of the order-level inventory coordinator, with the database replaced
 * by mocks.
 *
 * These tests can prove which quantities are derived from the persisted lines, that
 * duplicate lines are merged, that variants are visited in ascending order, which
 * client every call receives, and which failure becomes a conflict. They cannot
 * prove that the guarded SQL is atomic, that a later failure really rolls back an
 * earlier update, or that two concurrent orders cannot both release the same units.
 * Those are PostgreSQL properties and are proved in
 * `test/inventory-reservations.e2e-spec.ts` against a real database.
 */
describe('OrderInventoryService', () => {
  let service: OrderInventoryService;
  let orderFindItemQuantitiesByOrderId: Mock;
  let inventoryFindByVariantIds: Mock;
  let inventoryReleaseReserved: Mock;
  let inventoryCommitReserved: Mock;

  beforeEach(async () => {
    orderFindItemQuantitiesByOrderId = vi.fn().mockResolvedValue([]);
    inventoryFindByVariantIds = vi.fn().mockResolvedValue([]);
    inventoryReleaseReserved = vi.fn().mockResolvedValue(1);
    inventoryCommitReserved = vi.fn().mockResolvedValue(1);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrderInventoryService,
        {
          provide: OrderRepository,
          useValue: {
            findItemQuantitiesByOrderId: orderFindItemQuantitiesByOrderId,
          },
        },
        {
          provide: InventoryRepository,
          useValue: {
            findByVariantIds: inventoryFindByVariantIds,
            releaseReserved: inventoryReleaseReserved,
            commitReserved: inventoryCommitReserved,
          },
        },
      ],
    }).compile();

    service = module.get(OrderInventoryService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('releaseReservedForOrder', () => {
    beforeEach(() => {
      orderFindItemQuantitiesByOrderId.mockResolvedValue([
        { variantId: VARIANT_A, quantity: 2 },
      ]);
      inventoryFindByVariantIds.mockResolvedValue([buildInventory(VARIANT_A)]);
    });

    it('releases exactly the quantity persisted on the order line', async () => {
      await service.releaseReservedForOrder(ORDER_ID, TRANSACTION);

      expect(orderFindItemQuantitiesByOrderId).toHaveBeenCalledWith(
        ORDER_ID,
        TRANSACTION,
      );
      expect(inventoryReleaseReserved).toHaveBeenCalledWith(
        VARIANT_A,
        2,
        TRANSACTION,
      );
      expect(inventoryCommitReserved).not.toHaveBeenCalled();
    });

    it('groups duplicate lines for the same variant into one movement', async () => {
      orderFindItemQuantitiesByOrderId.mockResolvedValue([
        { variantId: VARIANT_B, quantity: 1 },
        { variantId: VARIANT_A, quantity: 2 },
        { variantId: VARIANT_B, quantity: 3 },
      ]);
      inventoryFindByVariantIds.mockResolvedValue([
        buildInventory(VARIANT_A),
        buildInventory(VARIANT_B),
      ]);

      await service.releaseReservedForOrder(ORDER_ID, TRANSACTION);

      expect(inventoryFindByVariantIds).toHaveBeenCalledWith(
        [VARIANT_A, VARIANT_B],
        TRANSACTION,
      );
      expect(inventoryReleaseReserved.mock.calls).toEqual([
        [VARIANT_A, 2, TRANSACTION],
        [VARIANT_B, 4, TRANSACTION],
      ]);
    });

    it('visits distinct variants in ascending id order', async () => {
      orderFindItemQuantitiesByOrderId.mockResolvedValue([
        { variantId: VARIANT_B, quantity: 1 },
        { variantId: VARIANT_A, quantity: 3 },
      ]);
      inventoryFindByVariantIds.mockResolvedValue([
        buildInventory(VARIANT_B),
        buildInventory(VARIANT_A),
      ]);

      await service.releaseReservedForOrder(ORDER_ID, TRANSACTION);

      expect(inventoryReleaseReserved.mock.calls.map((call) => call[0])).toEqual(
        [VARIANT_A, VARIANT_B],
      );
    });

    it('derives the whole movement from the persisted order id', async () => {
      await service.releaseReservedForOrder(ORDER_ID, TRANSACTION);

      // The method's only inputs are an id and a transaction; there is nowhere for
      // a request body or a frontend quantity to enter.
      expect(orderFindItemQuantitiesByOrderId).toHaveBeenCalledTimes(1);
      expect(orderFindItemQuantitiesByOrderId.mock.calls[0][0]).toBe(ORDER_ID);
    });

    it('rejects an order with no lines before reading inventory', async () => {
      orderFindItemQuantitiesByOrderId.mockResolvedValue([]);

      await expect(
        service.releaseReservedForOrder(ORDER_ID, TRANSACTION),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(inventoryFindByVariantIds).not.toHaveBeenCalled();
      expect(inventoryReleaseReserved).not.toHaveBeenCalled();
    });

    it.each([0, -1, 1.5])(
      'rejects a persisted quantity of %s before touching inventory',
      async (quantity) => {
        orderFindItemQuantitiesByOrderId.mockResolvedValue([
          { variantId: VARIANT_A, quantity },
        ]);

        await expect(
          service.releaseReservedForOrder(ORDER_ID, TRANSACTION),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(inventoryFindByVariantIds).not.toHaveBeenCalled();
        expect(inventoryReleaseReserved).not.toHaveBeenCalled();
      },
    );

    it('rejects a missing inventory row before releasing anything', async () => {
      orderFindItemQuantitiesByOrderId.mockResolvedValue([
        { variantId: VARIANT_A, quantity: 1 },
        { variantId: VARIANT_B, quantity: 1 },
      ]);
      inventoryFindByVariantIds.mockResolvedValue([buildInventory(VARIANT_A)]);

      await expect(
        service.releaseReservedForOrder(ORDER_ID, TRANSACTION),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(inventoryReleaseReserved).not.toHaveBeenCalled();
    });

    it('rejects an incoherent stock row before releasing anything', async () => {
      inventoryFindByVariantIds.mockResolvedValue([
        buildInventory(VARIANT_A, 2, 3),
      ]);

      await expect(
        service.releaseReservedForOrder(ORDER_ID, TRANSACTION),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(inventoryReleaseReserved).not.toHaveBeenCalled();
    });

    it('maps a refused guarded release to a conflict', async () => {
      inventoryReleaseReserved.mockResolvedValue(0);

      await expect(
        service.releaseReservedForOrder(ORDER_ID, TRANSACTION),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects an affected-row count other than one', async () => {
      inventoryReleaseReserved.mockResolvedValue(2);

      await expect(
        service.releaseReservedForOrder(ORDER_ID, TRANSACTION),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('propagates a later failure after earlier variants were updated', async () => {
      orderFindItemQuantitiesByOrderId.mockResolvedValue([
        { variantId: VARIANT_A, quantity: 1 },
        { variantId: VARIANT_B, quantity: 1 },
      ]);
      inventoryFindByVariantIds.mockResolvedValue([
        buildInventory(VARIANT_A),
        buildInventory(VARIANT_B),
      ]);
      inventoryReleaseReserved
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(0);

      await expect(
        service.releaseReservedForOrder(ORDER_ID, TRANSACTION),
      ).rejects.toBeInstanceOf(ConflictException);

      // The earlier update was issued. Only the caller's transaction can undo it;
      // the integration suite proves that it does.
      expect(inventoryReleaseReserved.mock.calls).toEqual([
        [VARIANT_A, 1, TRANSACTION],
        [VARIANT_B, 1, TRANSACTION],
      ]);
    });
  });

  describe('commitReservedForOrder', () => {
    beforeEach(() => {
      orderFindItemQuantitiesByOrderId.mockResolvedValue([
        { variantId: VARIANT_B, quantity: 3 },
        { variantId: VARIANT_A, quantity: 2 },
      ]);
      inventoryFindByVariantIds.mockResolvedValue([
        buildInventory(VARIANT_A),
        buildInventory(VARIANT_B),
      ]);
    });

    it('commits grouped quantities for every variant in ascending order', async () => {
      await service.commitReservedForOrder(ORDER_ID, TRANSACTION);

      expect(inventoryCommitReserved.mock.calls).toEqual([
        [VARIANT_A, 2, TRANSACTION],
        [VARIANT_B, 3, TRANSACTION],
      ]);
      expect(inventoryReleaseReserved).not.toHaveBeenCalled();
    });

    it('groups duplicate lines for the same variant', async () => {
      orderFindItemQuantitiesByOrderId.mockResolvedValue([
        { variantId: VARIANT_A, quantity: 1 },
        { variantId: VARIANT_A, quantity: 4 },
      ]);

      await service.commitReservedForOrder(ORDER_ID, TRANSACTION);

      expect(inventoryCommitReserved).toHaveBeenCalledTimes(1);
      expect(inventoryCommitReserved).toHaveBeenCalledWith(
        VARIANT_A,
        5,
        TRANSACTION,
      );
    });

    it('maps a refused guarded commitment to a conflict', async () => {
      inventoryCommitReserved.mockResolvedValue(0);

      await expect(
        service.commitReservedForOrder(ORDER_ID, TRANSACTION),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects a missing inventory row before committing anything', async () => {
      inventoryFindByVariantIds.mockResolvedValue([buildInventory(VARIANT_A)]);

      await expect(
        service.commitReservedForOrder(ORDER_ID, TRANSACTION),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(inventoryCommitReserved).not.toHaveBeenCalled();
    });

    it('rejects an incoherent stock row before committing anything', async () => {
      inventoryFindByVariantIds.mockResolvedValue([
        buildInventory(VARIANT_A, 1, 2),
        buildInventory(VARIANT_B),
      ]);

      await expect(
        service.commitReservedForOrder(ORDER_ID, TRANSACTION),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(inventoryCommitReserved).not.toHaveBeenCalled();
    });
  });
});
