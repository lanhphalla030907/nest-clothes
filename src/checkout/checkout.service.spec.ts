import {
  BadRequestException,
  ConflictException,
  type HttpException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import type { Mock } from 'vitest';
import { Prisma } from '../generated/prisma/client.js';
import { AddressesService } from '../addresses/addresses.service.js';
import { CartRepository } from '../cart/repositories/cart.repository.js';
import { InventoryRepository } from '../inventory/repositories/inventory.repository.js';
import { OrderService } from '../orders/order.service.js';
import { UsersRepository } from '../users/repositories/users.repository.js';
import { CheckoutService } from './checkout.service.js';

/**
 * The rules of checkout, with the database replaced by mocks.
 *
 * What these tests can prove: the *order* of the steps, which repository is asked for
 * what, which client each call receives, and which failure produces which status.
 * Those are decisions made in this file's subject and nowhere else.
 *
 * What they cannot prove, and why that is fine: that the guarded reservation is
 * actually atomic, that a rollback really undoes a reservation, and that two
 * concurrent checkouts cannot both win. None of that is a property of TypeScript —
 * it is a property of PostgreSQL, and it is proved in `test/checkout.e2e-spec.ts`
 * against a real database. A mock of `reserve` that returns `0` proves the 409 is
 * raised; only the database can prove that a second writer *gets* `0`.
 */

const USER_ID = 'a1b2c3d4-e5f6-4f70-8a9b-0c1d2e3f4a5b';
const ADDRESS_ID = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';
const CART_ID = 'c3d4e5f6-a7b8-4c90-8d1e-2f3a4b5c6d7e';
const VARIANT_A = 'd4e5f6a7-b8c9-4d01-9e2f-3a4b5c6d7e8f';
const VARIANT_B = 'e5f6a7b8-c9d0-4e12-af30-4b5c6d7e8f90';
const TRANSACTION = { tag: 'tx' } as unknown as Prisma.TransactionClient;

const buildCartItem = (
  variantId: string,
  quantity: number,
  createdAt = new Date('2026-01-04T10:00:00.000Z'),
) =>
  ({
    id: `item-${variantId}`,
    cartId: CART_ID,
    variantId,
    quantity,
    createdAt,
    updatedAt: createdAt,
    variant: { id: variantId, product: { id: 'p1', name: 'Wool Peacoat', isActive: true } },
  }) as never;

const buildCart = (
  items: ReturnType<typeof buildCartItem>[] = [buildCartItem(VARIANT_A, 2)],
) =>
  ({
    id: CART_ID,
    userId: USER_ID,
    createdAt: new Date('2026-01-01T09:00:00.000Z'),
    updatedAt: new Date('2026-01-04T10:00:00.000Z'),
    items,
  }) as never;

const buildAddress = (overrides: Record<string, unknown> = {}) => ({
  id: ADDRESS_ID,
  userId: USER_ID,
  label: 'Home',
  recipientName: 'Ada Lovelace',
  phone: '+15555550100',
  addressLine1: '18 Mill Lane',
  addressLine2: null,
  city: 'Bristol',
  stateProvince: null,
  postalCode: 'BS1 4TR',
  countryCode: 'GB',
  isDefault: true,
  createdAt: new Date('2026-01-01T09:00:00.000Z'),
  updatedAt: new Date('2026-01-01T09:00:00.000Z'),
  ...overrides,
});

const buildResolvedLine = (
  variantId: string,
  quantity: number,
  sku = `SKU-${variantId.slice(0, 4)}`,
) => ({
  variantId,
  productName: 'Wool Peacoat',
  sku,
  variantOptionsSnapshot: [{ optionName: 'Color', optionValue: 'Navy' }],
  unitPrice: new Prisma.Decimal('129.00'),
  quantity,
  lineTotal: new Prisma.Decimal('129.00').mul(quantity),
});

const buildOrder = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'o1',
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
    createdAt: new Date('2026-01-04T10:05:00.000Z'),
    updatedAt: new Date('2026-01-04T10:05:00.000Z'),
    items: [],
    ...overrides,
  }) as never;

const DTO = { addressId: ADDRESS_ID };

/** A `P2002` on `orders.order_number`, i.e. the order-number race. */
const buildOrderNumberViolation = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '7.10.0',
    meta: { modelName: 'Order', target: ['order_number'] },
  });

describe('CheckoutService', () => {
  let service: CheckoutService;
  let cartFindByUserId: Mock;
  let cartDeleteItemsByCart: Mock;
  let cartRunInTransaction: Mock;
  let inventoryFindByVariantId: Mock;
  let inventoryReserve: Mock;
  let orderDrawOrderNumber: Mock;
  let orderResolveOrderLines: Mock;
  let orderWriteOrder: Mock;
  let orderIsOrderNumberCollision: Mock;
  let addressesFindOne: Mock;
  let usersFindById: Mock;

  beforeEach(async () => {
    cartFindByUserId = vi.fn().mockResolvedValue(buildCart());
    cartDeleteItemsByCart = vi.fn().mockResolvedValue(1);
    cartRunInTransaction = vi.fn((work: (tx: unknown) => Promise<unknown>) =>
      (work as (tx: Prisma.TransactionClient) => Promise<unknown>)(TRANSACTION),
    );
    inventoryFindByVariantId = vi
      .fn()
      .mockResolvedValue({ variantId: VARIANT_A, quantity: 10, reservedQuantity: 0 });
    inventoryReserve = vi.fn().mockResolvedValue(1);
    orderDrawOrderNumber = vi.fn().mockReturnValue('ORD-20260104-AAAAAA');
    orderResolveOrderLines = vi
      .fn()
      .mockResolvedValue([buildResolvedLine(VARIANT_A, 2)]);
    orderWriteOrder = vi.fn().mockResolvedValue(buildOrder());
    orderIsOrderNumberCollision = vi.fn().mockReturnValue(false);
    addressesFindOne = vi.fn().mockResolvedValue(buildAddress());
    usersFindById = vi.fn().mockResolvedValue({ id: USER_ID });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CheckoutService,
        {
          provide: CartRepository,
          useValue: {
            findByUserId: cartFindByUserId,
            deleteItemsByCart: cartDeleteItemsByCart,
            runInTransaction: cartRunInTransaction,
          },
        },
        {
          provide: InventoryRepository,
          useValue: {
            findByVariantId: inventoryFindByVariantId,
            reserve: inventoryReserve,
          },
        },
        {
          provide: OrderService,
          useValue: {
            drawOrderNumber: orderDrawOrderNumber,
            resolveOrderLines: orderResolveOrderLines,
            writeOrder: orderWriteOrder,
            isOrderNumberCollision: orderIsOrderNumberCollision,
          },
        },
        {
          provide: AddressesService,
          useValue: { findOne: addressesFindOne },
        },
        { provide: UsersRepository, useValue: { findById: usersFindById } },
      ],
    }).compile();

    service = module.get(CheckoutService);
  });

  describe('the happy path', () => {
    it('returns the order it created, projected onto the receipt', async () => {
      const result = await service.checkout(USER_ID, DTO);

      expect(result.orderNumber).toBe('ORD-20260104-AAAAAA');
      expect(result.status).toBe('PENDING');
      expect(result.currency).toBe('USD');
      expect(result.subtotal).toBe('258.00');
      expect(result.totalAmount).toBe('258.00');
    });

    it('runs the whole checkout inside one transaction', async () => {
      await service.checkout(USER_ID, DTO);

      expect(cartRunInTransaction).toHaveBeenCalledTimes(1);
      // Every step receives that same client, which is what makes them one unit.
      expect(cartFindByUserId).toHaveBeenCalledWith(USER_ID, TRANSACTION);
      expect(addressesFindOne).toHaveBeenCalledWith(
        USER_ID,
        ADDRESS_ID,
        TRANSACTION,
      );
      expect(orderResolveOrderLines).toHaveBeenCalledWith(expect.anything(), TRANSACTION);
      expect(inventoryFindByVariantId).toHaveBeenCalledWith(VARIANT_A, TRANSACTION);
      expect(inventoryReserve).toHaveBeenCalledWith(VARIANT_A, 2, TRANSACTION);
      expect(orderWriteOrder).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'ORD-20260104-AAAAAA',
        TRANSACTION,
      );
      expect(cartDeleteItemsByCart).toHaveBeenCalledWith(CART_ID, TRANSACTION);
    });

    it('clears the cart only after the order is written', async () => {
      const calls: string[] = [];
      orderWriteOrder.mockImplementation(async () => {
        calls.push('write');
        return buildOrder();
      });
      cartDeleteItemsByCart.mockImplementation(async () => {
        calls.push('clear');
        return 1;
      });

      await service.checkout(USER_ID, DTO);

      expect(calls).toEqual(['write', 'clear']);
    });

    it('reserves stock before it writes the order', async () => {
      const calls: string[] = [];
      inventoryReserve.mockImplementation(async () => {
        calls.push('reserve');
        return 1;
      });
      orderWriteOrder.mockImplementation(async () => {
        calls.push('write');
        return buildOrder();
      });

      await service.checkout(USER_ID, DTO);

      expect(calls).toEqual(['reserve', 'write']);
    });

    it('copies the address onto the order instead of referencing it', async () => {
      await service.checkout(USER_ID, DTO);

      expect(orderWriteOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: USER_ID,
          shipping: expect.objectContaining({
            recipientName: 'Ada Lovelace',
            phone: '+15555550100',
            addressLine1: '18 Mill Lane',
            addressLine2: null,
            city: 'Bristol',
            stateProvince: null,
            postalCode: 'BS1 4TR',
            countryCode: 'GB',
          }),
        }),
        expect.anything(),
        expect.anything(),
        TRANSACTION,
      );
      // The address id itself is not carried into the order: an order must not
      // depend on a row that can later be edited or deleted.
      expect(orderWriteOrder.mock.calls[0][0]).not.toHaveProperty('addressId');
    });

    it('leaves shipping and discount at zero by not naming them', async () => {
      await service.checkout(USER_ID, DTO);

      const input = orderWriteOrder.mock.calls[0][0];
      expect(input).not.toHaveProperty('shippingFee');
      expect(input).not.toHaveProperty('discountAmount');
      expect(input).not.toHaveProperty('currency');
    });

    it('asks for exactly the cart lines, with no price attached', async () => {
      cartFindByUserId.mockResolvedValue(
        buildCart([
          buildCartItem(VARIANT_A, 2, new Date('2026-01-04T10:00:00.000Z')),
          buildCartItem(VARIANT_B, 1, new Date('2026-01-04T11:00:00.000Z')),
        ]),
      );
      orderResolveOrderLines.mockResolvedValue([
        buildResolvedLine(VARIANT_A, 2),
        buildResolvedLine(VARIANT_B, 1),
      ]);

      await service.checkout(USER_ID, DTO);

      expect(orderResolveOrderLines).toHaveBeenCalledWith(
        [
          { variantId: VARIANT_A, quantity: 2 },
          { variantId: VARIANT_B, quantity: 1 },
        ],
        TRANSACTION,
      );
      for (const line of orderResolveOrderLines.mock.calls[0][0]) {
        expect(Object.keys(line)).toEqual(['variantId', 'quantity']);
      }
    });

    it('prices from the catalogue, so a client cannot state what it pays', async () => {
      await service.checkout(USER_ID, DTO);

      // The service never reads a price of its own accord; the resolved lines it
      // receives from OrderService already carry the database price.
      expect(orderResolveOrderLines).toHaveBeenCalledTimes(1);
      expect(orderWriteOrder.mock.calls[0][1]).toEqual([
        buildResolvedLine(VARIANT_A, 2),
      ]);
    });

    it('reserves in variant-id order, whatever order the cart lines are in', async () => {
      // Two baskets sharing variants but listed in opposite orders would otherwise
      // take each other's rows in opposite orders and deadlock.
      const first = '00000000-0000-4000-8000-000000000001';
      const second = '00000000-0000-4000-8000-000000000002';
      cartFindByUserId.mockResolvedValue(
        buildCart([
          buildCartItem(second, 1),
          buildCartItem(first, 1),
        ]),
      );
      orderResolveOrderLines.mockResolvedValue([
        buildResolvedLine(second, 1),
        buildResolvedLine(first, 1),
      ]);

      await service.checkout(USER_ID, DTO);

      expect(inventoryReserve.mock.calls.map((call) => call[0])).toEqual([
        first,
        second,
      ]);
    });

    it('keeps the receipt in the order the cart listed its lines', async () => {
      // Reservation order and receipt order are different concerns: locking is for
      // deadlock avoidance, the receipt is what the customer bought first.
      const first = '00000000-0000-4000-8000-000000000001';
      const second = '00000000-0000-4000-8000-000000000002';
      cartFindByUserId.mockResolvedValue(
        buildCart([buildCartItem(second, 1), buildCartItem(first, 1)]),
      );
      const resolved = [
        buildResolvedLine(second, 1),
        buildResolvedLine(first, 1),
      ];
      orderResolveOrderLines.mockResolvedValue(resolved);

      await service.checkout(USER_ID, DTO);

      expect(orderWriteOrder.mock.calls[0][1]).toEqual(resolved);
    });
  });

  describe('validation', () => {
    it('rejects a user that does not exist, before opening a transaction', async () => {
      usersFindById.mockResolvedValue(null);

      const error = (await service
        .checkout(USER_ID, DTO)
        .catch((reason: unknown) => reason)) as HttpException;

      expect(error).toBeInstanceOf(NotFoundException);
      expect(error.message).toMatch(/does not exist/);
      expect(cartRunInTransaction).not.toHaveBeenCalled();
    });

    it('rejects a cart that does not exist', async () => {
      cartFindByUserId.mockResolvedValue(null);

      const error = (await service
        .checkout(USER_ID, DTO)
        .catch((reason: unknown) => reason)) as HttpException;

      expect(error).toBeInstanceOf(NotFoundException);
      expect(error.message).toMatch(/cart does not exist/i);
      expect(inventoryReserve).not.toHaveBeenCalled();
      expect(orderWriteOrder).not.toHaveBeenCalled();
    });

    it('rejects an empty cart', async () => {
      cartFindByUserId.mockResolvedValue(buildCart([]));

      const error = (await service
        .checkout(USER_ID, DTO)
        .catch((reason: unknown) => reason)) as HttpException;

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.message).toMatch(/empty cart/i);
      expect(orderWriteOrder).not.toHaveBeenCalled();
    });

    it('rejects an address that belongs to somebody else, as a 404', async () => {
      // AddressesService answers 404 for both "no such address" and "not yours", so
      // a caller cannot use checkout to probe another user's address book.
      addressesFindOne.mockRejectedValue(
        new NotFoundException(`Address ${ADDRESS_ID} does not exist`),
      );

      const error = (await service
        .checkout(USER_ID, DTO)
        .catch((reason: unknown) => reason)) as HttpException;

      expect(error).toBeInstanceOf(NotFoundException);
      expect(inventoryReserve).not.toHaveBeenCalled();
    });

    it('rejects a cart line whose quantity is not a positive whole number', async () => {
      orderResolveOrderLines.mockResolvedValue([buildResolvedLine(VARIANT_A, 0)]);

      const error = (await service
        .checkout(USER_ID, DTO)
        .catch((reason: unknown) => reason)) as HttpException;

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.message).toMatch(/positive whole number/i);
      expect(inventoryReserve).not.toHaveBeenCalled();
      expect(orderWriteOrder).not.toHaveBeenCalled();
    });

    it.each([
      ['a fraction', 1.5],
      ['a negative', -2],
      ['NaN', Number.NaN],
    ])('rejects %s as a quantity', async (_label, quantity) => {
      orderResolveOrderLines.mockResolvedValue([
        buildResolvedLine(VARIANT_A, quantity),
      ]);

      const error = (await service
        .checkout(USER_ID, DTO)
        .catch((reason: unknown) => reason)) as HttpException;

      expect(error).toBeInstanceOf(BadRequestException);
    });

    it('lets the sellability rules come from OrderService, not repeat them', async () => {
      // An inactive variant and a withdrawn product are decided by the catalogue
      // rules that already exist; checkout only adds stock, which it alone owns.
      orderResolveOrderLines.mockRejectedValue(
        new BadRequestException(
          `Product variant ${VARIANT_A} is not active and cannot be ordered`,
        ),
      );

      const error = (await service
        .checkout(USER_ID, DTO)
        .catch((reason: unknown) => reason)) as HttpException;

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.message).toMatch(/not active/);
      expect(inventoryReserve).not.toHaveBeenCalled();
    });
  });

  describe('stock reservation', () => {
    it('answers 409 when the guarded update refuses the hold', async () => {
      // `0` is what the statement returns when another checkout took the remainder
      // between this transaction's read and its write.
      inventoryReserve.mockResolvedValue(0);

      const error = (await service
        .checkout(USER_ID, DTO)
        .catch((reason: unknown) => reason)) as HttpException;

      expect(error).toBeInstanceOf(ConflictException);
      expect(error.message).toMatch(/exceeds the available stock/i);
    });

    it('never writes the order after a refused reservation', async () => {
      inventoryReserve.mockResolvedValue(0);

      await service.checkout(USER_ID, DTO).catch(() => undefined);

      expect(orderWriteOrder).not.toHaveBeenCalled();
      // And the cart keeps its lines, because clearing happens last and never ran.
      expect(cartDeleteItemsByCart).not.toHaveBeenCalled();
    });

    it('distinguishes a variant that is not stocked at all', async () => {
      inventoryFindByVariantId.mockResolvedValue(null);

      const error = (await service
        .checkout(USER_ID, DTO)
        .catch((reason: unknown) => reason)) as HttpException;

      expect(error).toBeInstanceOf(ConflictException);
      // A different sentence from "we are out of it": the variant has no ledger row.
      expect(error.message).toMatch(/not stocked/i);
      expect(error.message).not.toMatch(/exceeds the available stock/i);
      expect(inventoryReserve).not.toHaveBeenCalled();
    });

    it('reads the inventory row before attempting the hold', async () => {
      await service.checkout(USER_ID, DTO);

      expect(inventoryFindByVariantId).toHaveBeenCalledWith(VARIANT_A, TRANSACTION);
      expect(inventoryFindByVariantId.mock.invocationCallOrder[0]).toBeLessThan(
        inventoryReserve.mock.invocationCallOrder[0],
      );
    });

    it('holds nothing when a later line cannot be reserved', async () => {
      // Reserving the first line and then failing is safe *only* because both
      // statements are in the transaction the failure rolls back. That rollback is
      // the database's job and is proved in the E2E suite.
      cartFindByUserId.mockResolvedValue(
        buildCart([buildCartItem(VARIANT_A, 1), buildCartItem(VARIANT_B, 1)]),
      );
      orderResolveOrderLines.mockResolvedValue([
        buildResolvedLine(VARIANT_A, 1),
        buildResolvedLine(VARIANT_B, 1),
      ]);
      inventoryReserve.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

      const error = (await service
        .checkout(USER_ID, DTO)
        .catch((reason: unknown) => reason)) as HttpException;

      expect(error).toBeInstanceOf(ConflictException);
      expect(orderWriteOrder).not.toHaveBeenCalled();
      expect(cartDeleteItemsByCart).not.toHaveBeenCalled();
    });

    it('checks the quantity before it takes a row lock', async () => {
      orderResolveOrderLines.mockResolvedValue([buildResolvedLine(VARIANT_A, 0)]);

      await service.checkout(USER_ID, DTO).catch(() => undefined);

      expect(inventoryFindByVariantId).not.toHaveBeenCalled();
    });
  });

  describe('retrying the whole transaction', () => {
    it('retries the entire transaction when it loses the order-number race', async () => {
      orderIsOrderNumberCollision.mockReturnValue(true);
      orderWriteOrder
        .mockRejectedValueOnce(buildOrderNumberViolation())
        .mockResolvedValueOnce(buildOrder());
      orderDrawOrderNumber
        .mockReturnValueOnce('ORD-20260104-AAAAAA')
        .mockReturnValueOnce('ORD-20260104-BBBBBB');

      const result = await service.checkout(USER_ID, DTO);

      expect(result.orderNumber).toBe('ORD-20260104-AAAAAA');
      // Two whole transactions, not two statements inside one.
      expect(cartRunInTransaction).toHaveBeenCalledTimes(2);
      expect(orderDrawOrderNumber).toHaveBeenCalledTimes(2);
      expect(orderWriteOrder.mock.calls[1][2]).toBe('ORD-20260104-BBBBBB');
    });

    it('re-reads the cart on the retry rather than reusing stale lines', async () => {
      orderIsOrderNumberCollision.mockReturnValue(true);
      orderWriteOrder
        .mockRejectedValueOnce(buildOrderNumberViolation())
        .mockResolvedValueOnce(buildOrder());

      await service.checkout(USER_ID, DTO);

      expect(cartFindByUserId).toHaveBeenCalledTimes(2);
      expect(inventoryReserve).toHaveBeenCalledTimes(2);
    });

    it('retries a serialization failure', async () => {
      orderIsOrderNumberCollision.mockReturnValue(false);
      orderWriteOrder
        .mockRejectedValueOnce(
          new Prisma.PrismaClientKnownRequestError(
            'Transaction failed due to a write conflict or a deadlock',
            { code: 'P2034', clientVersion: '7.10.0' },
          ),
        )
        .mockResolvedValueOnce(buildOrder());

      await service.checkout(USER_ID, DTO);

      expect(cartRunInTransaction).toHaveBeenCalledTimes(2);
    });

    it.each([
      ['a raw SQLSTATE as the code', '40001', 'write conflict'],
      ['a raw SQLSTATE for a deadlock', '40P01', 'deadlock detected'],
      [
        'a SQLSTATE only in the message',
        'P2010',
        '40001 could not serialize access due to concurrent update',
      ],
    ])(
      'retries a transaction conflict delivered as %s',
      async (_label, code, message) => {
        orderWriteOrder
          .mockRejectedValueOnce(
            new Prisma.PrismaClientKnownRequestError(message, {
              code,
              clientVersion: '7.10.0',
            }),
          )
          .mockResolvedValueOnce(buildOrder());

        await service.checkout(USER_ID, DTO);

        expect(cartRunInTransaction).toHaveBeenCalledTimes(2);
      },
    );

    it('gives up after three attempts rather than retrying forever', async () => {
      orderIsOrderNumberCollision.mockReturnValue(true);
      orderWriteOrder.mockRejectedValue(buildOrderNumberViolation());

      const error = (await service
        .checkout(USER_ID, DTO)
        .catch((reason: unknown) => reason)) as HttpException;

      expect(error).toBeInstanceOf(BadRequestException);
      expect(cartRunInTransaction).toHaveBeenCalledTimes(3);
    });

    it('does not retry a check-constraint failure, which is a real fault', async () => {
      // Retrying arithmetic that is already wrong just produces the same wrong
      // answer more slowly.
      orderIsOrderNumberCollision.mockReturnValue(false);
      orderWriteOrder.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError(
          'Constraint failed on the database: `orders_total_amount_identity`',
          { code: 'P2039', clientVersion: '7.10.0' },
        ),
      );

      const error = (await service
        .checkout(USER_ID, DTO)
        .catch((reason: unknown) => reason)) as HttpException;

      expect(error).toBeInstanceOf(BadRequestException);
      expect(cartRunInTransaction).toHaveBeenCalledTimes(1);
    });

    it('does not retry a plain 400 from a business rule', async () => {
      orderWriteOrder.mockRejectedValue(
        new BadRequestException('Cart changed concurrently; retry the request'),
      );

      await service.checkout(USER_ID, DTO).catch(() => undefined);

      expect(cartRunInTransaction).toHaveBeenCalledTimes(1);
    });

    it('does not retry a 409 for insufficient stock', async () => {
      // Someone else's checkout winning is not a transient fault of ours: the answer
      // is that there is not enough stock, and retrying would say the same thing.
      inventoryReserve.mockResolvedValue(0);

      await service.checkout(USER_ID, DTO).catch(() => undefined);

      expect(cartRunInTransaction).toHaveBeenCalledTimes(1);
    });

    it('never re-issues a statement inside the failed transaction', async () => {
      orderIsOrderNumberCollision.mockReturnValue(true);
      orderWriteOrder
        .mockRejectedValueOnce(buildOrderNumberViolation())
        .mockResolvedValueOnce(buildOrder());

      await service.checkout(USER_ID, DTO);

      // The attempt counter lives outside `runInTransaction`, so a second attempt is
      // necessarily a second transaction rather than a resumed one.
      const outerAttempts = cartRunInTransaction.mock.calls.length;
      expect(outerAttempts).toBe(2);
      for (const call of cartRunInTransaction.mock.calls) {
        expect(call).toHaveLength(1);
      }
    });
  });

  describe('what the response must not contain', () => {
    it('carries no user fields and no password hash', async () => {
      orderWriteOrder.mockResolvedValue(
        buildOrder({
          user: {
            id: USER_ID,
            email: 'ada@example.test',
            passwordHash: 'argon2-secret',
          },
        }),
      );

      const result = await service.checkout(USER_ID, DTO);

      const serialised = JSON.stringify(result);
      expect(serialised).not.toContain('argon2-secret');
      expect(serialised).not.toContain('ada@example.test');
      expect(Object.keys(result)).not.toContain('user');
      // `userId` *is* part of the order contract — the client already knows whose
      // order it is. What must never appear is a joined user row.
      expect(result.userId).toBe(USER_ID);
    });

    it('carries no inventory fields', async () => {
      orderWriteOrder.mockResolvedValue(
        buildOrder({
          inventory: { quantity: 10, reservedQuantity: 2 },
        }),
      );

      const result = await service.checkout(USER_ID, DTO);

      const serialised = JSON.stringify(result);
      expect(serialised).not.toContain('reservedQuantity');
      expect(serialised).not.toContain('quantity');
    });

    it('renders every amount as a two-decimal string', async () => {
      const result = await service.checkout(USER_ID, DTO);

      for (const amount of [
        result.subtotal,
        result.shippingFee,
        result.discountAmount,
        result.totalAmount,
      ]) {
        expect(typeof amount).toBe('string');
        expect(amount).toMatch(/^-?\d+\.\d{2}$/);
      }
      // Zero shipping and zero discount are real figures, not absent ones.
      expect(result.shippingFee).toBe('0.00');
      expect(result.discountAmount).toBe('0.00');
    });
  });
});
