import 'dotenv/config';
import { ConflictException, type INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { Prisma } from '../src/generated/prisma/client.js';
import { OrderInventoryService } from '../src/orders/order-inventory.service.js';
import { OrderModule } from '../src/orders/order.module.js';
import {
  OrderRepository,
  type OrderTransactionClient,
} from '../src/orders/repositories/order.repository.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * The order-level inventory movements against a **real PostgreSQL** database.
 *
 * The unit suite proves which quantities are derived from persisted lines and which
 * failure becomes which exception. It cannot prove the claims that matter most here,
 * because those are properties of the SQL and of concurrent transactions:
 *
 * - `releaseReserved` changes only `reserved_quantity`; `commitReserved` changes both
 *   counters.
 * - A guarded update that finds insufficient stock changes no row and leaves both
 *   counters exactly as they were — it never clamps and never goes negative.
 * - A later variant's failure rolls back the earlier variants' updates when the
 *   caller's transaction is the one wrapping the whole movement.
 * - Two concurrent releases cannot both spend the same reservation; two concurrent
 *   commitments cannot both ship the same units.
 * - Two multi-variant orders presented in opposite line order do not deadlock,
 *   because the service visits variants in one ascending order.
 *
 * A mock would make all of those "pass" without a database ever evaluating a
 * `WHERE` clause, so this file is intentionally separate from the unit spec.
 */
describe('Order inventory movements (PostgreSQL)', () => {
  const run = randomUUID().slice(0, 8);
  const VARIANT_A = `${run}-0000-4000-8000-000000000001`;
  const VARIANT_B = `${run}-0000-4000-8000-000000000002`;

  const email = (name: string) => `inventory-${run}-${name}@example.test`;
  const slug = (name: string) => `inventory-${run}-${name}`;

  let app: INestApplication;
  let prisma: PrismaService;
  let orderRepository: OrderRepository;
  let inventory: OrderInventoryService;

  let userId: string;
  let productId: string;
  let categoryId: string;
  let orderCounter = 0;

  /** Creates one variant's stock row from scratch for the current test. */
  const setStock = (
    variantId: string,
    quantity: number,
    reservedQuantity: number,
  ) =>
    prisma.inventory.create({
      data: { variantId, quantity, reservedQuantity },
    });

  /** Reads a variant's counters, failing loudly if the row disappeared. */
  const stock = (variantId: string) =>
    prisma.inventory.findUniqueOrThrow({ where: { variantId } });

  /**
   * Writes an order straight through Prisma.
   *
   * The line quantities are the fixture's equivalent of "what checkout persisted";
   * the service under test never receives them directly, only the order id. The
   * totals are computed with `Decimal` so the `orders_total_matches_components` and
   * `order_items_total_matches_line` checks cannot reject a hand-written mistake.
   */
  const createOrder = async (
    lines: { variantId: string; quantity: number }[],
  ) => {
    const unitPrice = '10.00';
    const subtotal = lines
      .reduce((total, line) => total + 10 * line.quantity, 0)
      .toFixed(2);
    orderCounter += 1;

    return prisma.order.create({
      data: {
        userId,
        orderNumber: `INV-${run}-${orderCounter}`,
        status: 'PENDING',
        subtotal,
        shippingFee: '0.00',
        discountAmount: '0.00',
        totalAmount: subtotal,
        currency: 'USD',
        shippingRecipientName: 'Inventory Tester',
        shippingPhone: '+15555550100',
        shippingAddressLine1: '18 Mill Lane',
        shippingCity: 'Bristol',
        shippingPostalCode: 'BS1 4TR',
        shippingCountryCode: 'GB',
        items: {
          create: lines.map((line) => ({
            variantId: line.variantId,
            productName: 'Inventory Coat',
            sku: slug('order-line'),
            variantOptionsSnapshot: [],
            unitPrice,
            quantity: line.quantity,
            lineTotal: new Prisma.Decimal(unitPrice)
              .times(line.quantity)
              .toFixed(2),
          })),
        },
      },
    });
  };

  const inTransaction = <T>(
    work: (tx: OrderTransactionClient) => Promise<T>,
  ): Promise<T> => orderRepository.runInTransaction(work);

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        'DATABASE_URL is not set — the inventory integration tests need a real PostgreSQL instance',
      );
    }

    const module: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule, OrderModule],
    }).compile();

    app = module.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    orderRepository = app.get(OrderRepository);
    inventory = app.get(OrderInventoryService);

    const category = await prisma.category.create({
      data: { name: `Inventory ${run}`, slug: slug('category') },
    });
    categoryId = category.id;

    const user = await prisma.user.create({
      data: {
        firstName: 'Inventory',
        lastName: 'Tester',
        email: email('owner'),
        passwordHash: 'argon2-not-a-real-hash',
        status: 'ACTIVE',
      },
    });
    userId = user.id;

    const product = await prisma.product.create({
      data: {
        categoryId,
        name: 'Inventory Coat',
        slug: slug('product'),
        basePrice: '10.00',
        status: 'ACTIVE',
      },
    });
    productId = product.id;

    // Explicit ids, not generated ones: the rollback tests need variant A to sort
    // before variant B so the first update genuinely succeeds before the second
    // fails. The run prefix keeps them unique across repeated suite runs.
    await prisma.productVariant.createMany({
      data: [
        { id: VARIANT_A, productId, sku: slug('sku-a'), price: '10.00' },
        { id: VARIANT_B, productId, sku: slug('sku-b'), price: '10.00' },
      ],
    });
  });

  afterEach(async () => {
    if (prisma === undefined) {
      return;
    }

    // Order lines reference variants with ON DELETE RESTRICT, and orders reference
    // the user, so orders go first and take their lines with them.
    await prisma.order.deleteMany({ where: { userId } });
    await prisma.inventory.deleteMany({
      where: { variantId: { in: [VARIANT_A, VARIANT_B] } },
    });
  });

  afterAll(async () => {
    if (prisma === undefined) {
      return;
    }

    await prisma.order.deleteMany({ where: { userId } });
    await prisma.inventory.deleteMany({
      where: { variantId: { in: [VARIANT_A, VARIANT_B] } },
    });
    await prisma.productVariant.deleteMany({ where: { productId } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.category.deleteMany({ where: { id: categoryId } });
    await prisma.user.deleteMany({ where: { id: userId } });

    await app.close();
  });

  describe('releaseReservedForOrder', () => {
    it('decreases reserved_quantity and leaves physical quantity untouched', async () => {
      await setStock(VARIANT_A, 10, 5);
      const order = await createOrder([{ variantId: VARIANT_A, quantity: 2 }]);

      await inTransaction((tx) =>
        inventory.releaseReservedForOrder(order.id, tx),
      );

      const row = await stock(VARIANT_A);
      expect(row.quantity).toBe(10);
      expect(row.reservedQuantity).toBe(3);
    });

    it('merges duplicate lines for one variant into a single total', async () => {
      await setStock(VARIANT_A, 10, 5);
      const order = await createOrder([
        { variantId: VARIANT_A, quantity: 1 },
        { variantId: VARIANT_A, quantity: 2 },
      ]);

      await inTransaction((tx) =>
        inventory.releaseReservedForOrder(order.id, tx),
      );

      const row = await stock(VARIANT_A);
      expect(row.quantity).toBe(10);
      expect(row.reservedQuantity).toBe(2);
    });

    it('releases every variant of a multi-line order', async () => {
      await setStock(VARIANT_A, 10, 5);
      await setStock(VARIANT_B, 10, 5);
      const order = await createOrder([
        { variantId: VARIANT_B, quantity: 3 },
        { variantId: VARIANT_A, quantity: 2 },
      ]);

      await inTransaction((tx) =>
        inventory.releaseReservedForOrder(order.id, tx),
      );

      const first = await stock(VARIANT_A);
      const second = await stock(VARIANT_B);
      expect(first.quantity).toBe(10);
      expect(first.reservedQuantity).toBe(3);
      expect(second.quantity).toBe(10);
      expect(second.reservedQuantity).toBe(2);
    });

    it('refuses to release more than is reserved and changes nothing', async () => {
      await setStock(VARIANT_A, 5, 1);
      const order = await createOrder([{ variantId: VARIANT_A, quantity: 2 }]);

      await expect(
        inTransaction((tx) => inventory.releaseReservedForOrder(order.id, tx)),
      ).rejects.toBeInstanceOf(ConflictException);

      const row = await stock(VARIANT_A);
      expect(row.quantity).toBe(5);
      expect(row.reservedQuantity).toBe(1);
    });

    it('rejects a variant with no inventory row before moving any counter', async () => {
      await setStock(VARIANT_A, 10, 5);
      const order = await createOrder([
        { variantId: VARIANT_A, quantity: 1 },
        { variantId: VARIANT_B, quantity: 1 },
      ]);

      await expect(
        inTransaction((tx) => inventory.releaseReservedForOrder(order.id, tx)),
      ).rejects.toBeInstanceOf(ConflictException);

      const row = await stock(VARIANT_A);
      expect(row.quantity).toBe(10);
      expect(row.reservedQuantity).toBe(5);
    });

    it('rolls back an earlier successful release when a later variant fails', async () => {
      // A has enough reservation, B does not. Suffix 0001 sorts before 0002, so A's
      // guarded update really runs first; only the transaction can undo it.
      await setStock(VARIANT_A, 10, 5);
      await setStock(VARIANT_B, 10, 1);
      const order = await createOrder([
        { variantId: VARIANT_A, quantity: 1 },
        { variantId: VARIANT_B, quantity: 2 },
      ]);

      await expect(
        inTransaction((tx) => inventory.releaseReservedForOrder(order.id, tx)),
      ).rejects.toBeInstanceOf(ConflictException);

      const first = await stock(VARIANT_A);
      const second = await stock(VARIANT_B);
      expect(first.reservedQuantity).toBe(5);
      expect(second.reservedQuantity).toBe(1);
    });

    it('allows exactly one of two concurrent releases to spend the reservation', async () => {
      await setStock(VARIANT_A, 5, 3);
      const firstOrder = await createOrder([
        { variantId: VARIANT_A, quantity: 2 },
      ]);
      const secondOrder = await createOrder([
        { variantId: VARIANT_A, quantity: 2 },
      ]);

      const results = await Promise.allSettled([
        inTransaction((tx) =>
          inventory.releaseReservedForOrder(firstOrder.id, tx),
        ),
        inTransaction((tx) =>
          inventory.releaseReservedForOrder(secondOrder.id, tx),
        ),
      ]);
      const fulfilled = results.filter(
        (result) => result.status === 'fulfilled',
      );
      const rejected = results.find((result) => result.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toBeDefined();
      expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(
        ConflictException,
      );

      const row = await stock(VARIANT_A);
      expect(row.quantity).toBe(5);
      expect(row.reservedQuantity).toBe(1);
    });
  });

  describe('commitReservedForOrder', () => {
    it('decreases both physical stock and the reservation', async () => {
      await setStock(VARIANT_A, 10, 5);
      const order = await createOrder([{ variantId: VARIANT_A, quantity: 2 }]);

      await inTransaction((tx) =>
        inventory.commitReservedForOrder(order.id, tx),
      );

      const row = await stock(VARIANT_A);
      expect(row.quantity).toBe(8);
      expect(row.reservedQuantity).toBe(3);
    });

    it('commits every variant of a multi-line order', async () => {
      await setStock(VARIANT_A, 10, 5);
      await setStock(VARIANT_B, 10, 5);
      const order = await createOrder([
        { variantId: VARIANT_A, quantity: 2 },
        { variantId: VARIANT_B, quantity: 1 },
        { variantId: VARIANT_A, quantity: 1 },
      ]);

      await inTransaction((tx) =>
        inventory.commitReservedForOrder(order.id, tx),
      );

      const first = await stock(VARIANT_A);
      const second = await stock(VARIANT_B);
      expect(first.quantity).toBe(7);
      expect(first.reservedQuantity).toBe(2);
      expect(second.quantity).toBe(9);
      expect(second.reservedQuantity).toBe(4);
    });

    it('refuses to commit more than the stock or reservation covers', async () => {
      // On a coherent row (`reserved <= quantity`) this also exercises the physical
      // guard: there is no state where `reserved >= 3` but `quantity < 3`.
      await setStock(VARIANT_A, 2, 2);
      const order = await createOrder([{ variantId: VARIANT_A, quantity: 3 }]);

      await expect(
        inTransaction((tx) => inventory.commitReservedForOrder(order.id, tx)),
      ).rejects.toBeInstanceOf(ConflictException);

      const row = await stock(VARIANT_A);
      expect(row.quantity).toBe(2);
      expect(row.reservedQuantity).toBe(2);
    });

    it('rolls back an earlier successful commitment when a later variant fails', async () => {
      await setStock(VARIANT_A, 10, 5);
      await setStock(VARIANT_B, 2, 2);
      const order = await createOrder([
        { variantId: VARIANT_A, quantity: 1 },
        { variantId: VARIANT_B, quantity: 3 },
      ]);

      await expect(
        inTransaction((tx) => inventory.commitReservedForOrder(order.id, tx)),
      ).rejects.toBeInstanceOf(ConflictException);

      const first = await stock(VARIANT_A);
      const second = await stock(VARIANT_B);
      expect(first.quantity).toBe(10);
      expect(first.reservedQuantity).toBe(5);
      expect(second.quantity).toBe(2);
      expect(second.reservedQuantity).toBe(2);
    });

    it('allows exactly one of two concurrent commitments to consume the stock', async () => {
      await setStock(VARIANT_A, 5, 5);
      const firstOrder = await createOrder([
        { variantId: VARIANT_A, quantity: 3 },
      ]);
      const secondOrder = await createOrder([
        { variantId: VARIANT_A, quantity: 3 },
      ]);

      const results = await Promise.allSettled([
        inTransaction((tx) =>
          inventory.commitReservedForOrder(firstOrder.id, tx),
        ),
        inTransaction((tx) =>
          inventory.commitReservedForOrder(secondOrder.id, tx),
        ),
      ]);
      const fulfilled = results.filter(
        (result) => result.status === 'fulfilled',
      );
      const rejected = results.find((result) => result.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toBeDefined();
      expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(
        ConflictException,
      );

      const row = await stock(VARIANT_A);
      expect(row.quantity).toBe(2);
      expect(row.reservedQuantity).toBe(2);
    });
  });

  describe('lock ordering', () => {
    it('does not deadlock when two orders list the same variants in opposite order', async () => {
      await setStock(VARIANT_A, 10, 5);
      await setStock(VARIANT_B, 10, 5);
      const firstOrder = await createOrder([
        { variantId: VARIANT_A, quantity: 1 },
        { variantId: VARIANT_B, quantity: 1 },
      ]);
      const secondOrder = await createOrder([
        { variantId: VARIANT_B, quantity: 1 },
        { variantId: VARIANT_A, quantity: 1 },
      ]);

      const results = await Promise.allSettled([
        inTransaction((tx) =>
          inventory.releaseReservedForOrder(firstOrder.id, tx),
        ),
        inTransaction((tx) =>
          inventory.releaseReservedForOrder(secondOrder.id, tx),
        ),
      ]);

      // Both orders fit within the reservation, so both must succeed. The service
      // sorts the grouped variant ids, so both transactions take A before B rather
      // than following their own line order.
      expect(results.map((result) => result.status)).toEqual([
        'fulfilled',
        'fulfilled',
      ]);

      const first = await stock(VARIANT_A);
      const second = await stock(VARIANT_B);
      expect(first.reservedQuantity).toBe(3);
      expect(second.reservedQuantity).toBe(3);
    });
  });
});
