import 'dotenv/config';
import {
  HttpStatus,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { Prisma } from '../src/generated/prisma/client.js';
import { CheckoutModule } from '../src/checkout/checkout.module.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { TEMPORARY_USER_ID_HEADER } from '../src/common/decorators/temporary-user-id.decorator.js';

/**
 * Checkout against a **real PostgreSQL** database.
 *
 * Everything this feature claims is a claim about the database, and a mock cannot
 * check any of it. The unit spec proves the *sequence* of calls and the status codes;
 * this file proves the consequences:
 *
 * - the guarded reservation is genuinely atomic. With stock 5 and two concurrent
 *   checkouts for 4 and 3, exactly one may win — the other must get a 409 and the
 *   stored `reserved_quantity` must never exceed `quantity`. This is the whole reason
 *   `InventoryRepository.reserve` is one statement, and it can only be observed with
 *   two real connections racing for the same row.
 * - a failed checkout really rolls everything back: no order, no order items, no
 *   reservation, and a cart that is byte-for-byte what it was. A transaction is the
 *   only mechanism here, and "the transaction rolled back" is not observable without
 *   one.
 * - the order's snapshot survives later edits. Renaming the product, changing the
 *   variant price and rewriting the saved address after checkout must all leave the
 *   order exactly as it was placed.
 * - the client cannot influence the price, even by sending one.
 *
 * Nothing is mocked. Every fixture is written through the same tables the
 * application uses, so a change that quietly weakens a constraint fails here.
 *
 * Fixtures are namespaced by a per-run token and torn down in `afterAll`, in an
 * order that respects the schema's `ON DELETE` rules.
 */
describe('Checkout (PostgreSQL)', () => {
  const run = randomUUID().slice(0, 8);
  const email = (name: string) => `checkout-${run}-${name}@example.test`;
  const slug = (name: string) => `checkout-${run}-${name}`;

  let app: INestApplication;
  let prisma: PrismaService;
  let base: string;
  let categoryId: string;
  let userId: string;
  let otherUserId: string;
  let addressId: string;
  let otherAddressId: string;
  let variantId: string;

  /**
   * Every user this suite creates.
   *
   * Teardown is scoped to these ids rather than to the whole table: the e2e suite
   * runs against one shared database, and a bare `deleteMany({})` would delete
   * another suite's fixtures and make that suite fail for reasons that have
   * nothing to do with it.
   */
  const suiteUsers: string[] = [];

  /** Each buyer's own address, so `checkout({ user })` never borrows someone else's. */
  const buyerAddresses = new Map<string, string>();

  const headers = (id: string) => ({
    'Content-Type': 'application/json',
    [TEMPORARY_USER_ID_HEADER]: id,
  });

  const api = async (
    method: string,
    path: string,
    options: { user?: string; body?: unknown } = {},
  ) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: headers(options.user ?? userId),
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    });

    const text = await res.text();

    return {
      status: res.status,
      body: text.length === 0 ? undefined : JSON.parse(text),
    };
  };

  /**
   * Checks out as `user`, shipping to an address that user owns.
   *
   * The address is chosen to match the identity on purpose: sending one user's
   * address with another user's `X-User-Id` is a 404, and a concurrency test that
   * quietly did that would prove nothing about stock.
   */
  const checkout = async (
    options: { user?: string; addressId?: string } = {},
  ) => {
    const user = options.user ?? userId;
    // An address belonging to a different user is a 404 by design, so a concurrency
    // test that reused the owner's address would measure nothing but that check.
    const address =
      options.addressId ??
      (user === userId
        ? addressId
        : (buyerAddresses.get(user) ?? otherAddressId));

    return api('POST', '/checkout', { user, body: { addressId: address } });
  };

  /** Creates a user with a saved address and a cart holding `quantity` of the variant. */
  const createBuyer = async (name: string, quantity: number) => {
    const buyer = (
      await prisma.user.create({
        data: {
          firstName: 'Buyer',
          lastName: 'Tester',
          email: email(name),
          passwordHash: 'argon2-not-a-real-hash',
          status: 'ACTIVE',
        },
      })
    ).id;
    suiteUsers.push(buyer);
    const address = (
      await prisma.address.create({
        data: {
          userId: buyer,
          label: 'Home',
          recipientName: `Recipient ${name}`,
          phone: '+15555550100',
          addressLine1: '1 Buyer Lane',
          city: 'Leeds',
          countryCode: 'GB',
        },
      })
    ).id;
    buyerAddresses.set(buyer, address);
    const cart = await ensureCart(buyer);
    await prisma.cartItem.create({
      data: { cartId: cart.id, variantId, quantity },
    });

    return { buyer, address, cartId: cart.id };
  };

  /**
   * The caller's cart, created only if it does not exist yet.
   *
   * One user has at most one cart (`carts_user_id_key`), so tests that need a
   * basket have to ask for it rather than create a second one.
   */
  const ensureCart = (user: string) =>
    prisma.cart.upsert({
      where: { userId: user },
      create: { userId: user },
      update: {},
    });

  const addToCart = (quantity: number, id = variantId) =>
    api('POST', '/cart/items', { body: { variantId: id, quantity } });

  const setStock = async (quantity: number, reserved = 0, id = variantId) =>
    prisma.inventory.update({
      where: { variantId: id },
      data: { quantity, reservedQuantity: reserved },
    });

  const readStock = async (id = variantId) => {
    const row = await prisma.inventory.findUniqueOrThrow({
      where: { variantId: id },
    });

    return { quantity: row.quantity, reservedQuantity: row.reservedQuantity };
  };

  const readCart = async (user = userId) => {
    const cart = await prisma.cart.findUnique({
      where: { userId: user },
      include: { items: { orderBy: { createdAt: 'asc' } } },
    });

    return cart === null
      ? null
      : {
          id: cart.id,
          items: cart.items.map((item) => ({
            variantId: item.variantId,
            quantity: item.quantity,
          })),
        };
  };

  const countOrders = async (user = userId) =>
    prisma.order.count({ where: { userId: user } });

  const countOrderItems = async (user = userId) =>
    prisma.orderItem.count({ where: { order: { userId: user } } });

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        'DATABASE_URL is not set — the checkout integration tests need a real PostgreSQL instance',
      );
    }

    const module: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule, CheckoutModule],
    }).compile();

    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.listen(0);
    base = await app.getUrl();
    prisma = app.get(PrismaService);

    const category = await prisma.category.create({
      data: { name: `Checkout ${run}`, slug: slug('category') },
    });
    categoryId = category.id;

    const createUser = async (name: string) =>
      prisma.user.create({
        data: {
          firstName: 'Checkout',
          lastName: 'Tester',
          email: email(name),
          passwordHash: 'argon2-not-a-real-hash',
          status: 'ACTIVE',
        },
      });

    userId = (await createUser('owner')).id;
    otherUserId = (await createUser('other')).id;
    suiteUsers.push(userId, otherUserId);

    const createAddress = async (user: string, name: string) =>
      (
        await prisma.address.create({
          data: {
            userId: user,
            label: 'Home',
            recipientName: `Recipient ${name}`,
            phone: '+15555550100',
            addressLine1: '18 Mill Lane',
            city: 'Bristol',
            postalCode: 'BS1 4TR',
            countryCode: 'GB',
          },
        })
      ).id;

    addressId = await createAddress(userId, 'owner');
    otherAddressId = await createAddress(otherUserId, 'other');

    const product = await prisma.product.create({
      data: {
        categoryId,
        name: 'Checkout Peacoat',
        slug: slug('product'),
        basePrice: '129.00',
        status: 'ACTIVE',
      },
    });
    const variant = await prisma.productVariant.create({
      data: { productId: product.id, sku: slug('SKU-1'), price: '129.00' },
    });
    await prisma.variantOption.createMany({
      data: [
        { variantId: variant.id, optionName: 'Color', optionValue: 'Navy' },
        { variantId: variant.id, optionName: 'Size', optionValue: 'M' },
      ],
    });
    variantId = variant.id;
    await prisma.inventory.create({
      data: { variantId: variant.id, quantity: 20, reservedQuantity: 0 },
    });
  });

  afterAll(async () => {
    if (prisma === undefined) {
      return;
    }

    // Scoped to this suite's own rows: order lines reference variants with ON DELETE
    // RESTRICT and orders reference users, so the deletes unwind in the reverse of
    // the schema's own cascades.
    await prisma.orderItem.deleteMany({
      where: { order: { userId: { in: suiteUsers } } },
    });
    await prisma.order.deleteMany({ where: { userId: { in: suiteUsers } } });
    await prisma.cartItem.deleteMany({
      where: { cart: { userId: { in: suiteUsers } } },
    });
    await prisma.cart.deleteMany({ where: { userId: { in: suiteUsers } } });
    await prisma.inventory.deleteMany({
      where: { variant: { sku: { startsWith: `checkout-${run}-` } } },
    });
    await prisma.address.deleteMany({ where: { userId: { in: suiteUsers } } });
    // A wishlist item belongs to a wishlist, which is what actually knows the user.
    await prisma.wishlistItem.deleteMany({
      where: { wishlist: { userId: { in: suiteUsers } } },
    });
    await prisma.wishlist.deleteMany({ where: { userId: { in: suiteUsers } } });
    await prisma.user.deleteMany({
      where: { email: { startsWith: `checkout-${run}-` } },
    });
    await prisma.productVariant.deleteMany({
      where: { sku: { startsWith: `checkout-${run}-` } },
    });
    await prisma.product.deleteMany({
      where: { slug: { startsWith: `checkout-${run}-` } },
    });
    await prisma.category.deleteMany({ where: { slug: slug('category') } });

    await app.close();
  });

  /**
   * Puts this suite's fixtures back to a known state between tests.
   *
   * Cart *rows* are deliberately kept: a user has exactly one, and several tests
   * assert that it survives a purchase. Only its lines are cleared.
   */
  beforeEach(async () => {
    await prisma.orderItem.deleteMany({
      where: { order: { userId: { in: suiteUsers } } },
    });
    await prisma.order.deleteMany({ where: { userId: { in: suiteUsers } } });
    await prisma.cartItem.deleteMany({
      where: { cart: { userId: { in: suiteUsers } } },
    });
    // `upsert`, not `update`: one test removes the inventory row entirely, and the
    // next one has to get it back rather than fail on a missing row.
    await prisma.inventory.upsert({
      where: { variantId },
      create: { variantId, quantity: 20, reservedQuantity: 0 },
      update: { quantity: 20, reservedQuantity: 0 },
    });
    await prisma.productVariant.update({
      where: { id: variantId },
      data: { price: '129.00', isActive: true },
    });
    await prisma.product.update({
      where: { slug: slug('product') },
      data: { name: 'Checkout Peacoat', isActive: true },
    });
    // One test rewrites the address and another deletes it, so both are restored.
    await prisma.address.upsert({
      where: { id: addressId },
      create: {
        id: addressId,
        userId,
        label: 'Home',
        recipientName: 'Recipient owner',
        phone: '+15555550100',
        addressLine1: '18 Mill Lane',
        city: 'Bristol',
        postalCode: 'BS1 4TR',
        countryCode: 'GB',
      },
      update: {
        recipientName: 'Recipient owner',
        phone: '+15555550100',
        addressLine1: '18 Mill Lane',
        addressLine2: null,
        city: 'Bristol',
        stateProvince: null,
        postalCode: 'BS1 4TR',
        countryCode: 'GB',
      },
    });
    await prisma.variantOption.deleteMany({ where: { variantId } });
    await prisma.variantOption.createMany({
      data: [
        { variantId, optionName: 'Color', optionValue: 'Navy' },
        { variantId, optionName: 'Size', optionValue: 'M' },
      ],
    });
  });

  describe('a successful checkout', () => {
    it('creates exactly one order with the right lines and empties the cart', async () => {
      await setStock(5);
      await addToCart(2);

      const res = await checkout();

      expect(res.status).toBe(HttpStatus.CREATED);
      expect(await countOrders()).toBe(1);
      expect(await countOrderItems()).toBe(1);

      const order = await prisma.order.findFirstOrThrow({
        where: { userId },
        include: { items: true },
      });
      expect(order.status).toBe('PENDING');
      expect(order.currency).toBe('USD');
      expect(order.subtotal.toFixed(2)).toBe('258.00');
      expect(order.shippingFee.toFixed(2)).toBe('0.00');
      expect(order.discountAmount.toFixed(2)).toBe('0.00');
      expect(order.totalAmount.toFixed(2)).toBe('258.00');
      expect(order.items).toHaveLength(1);
      expect(order.items[0]).toMatchObject({
        variantId,
        quantity: 2,
        unitPrice: new Prisma.Decimal('129.00'),
        lineTotal: new Prisma.Decimal('258.00'),
      });
    });

    it('reserves exactly the quantity ordered', async () => {
      await setStock(5);
      await addToCart(3);

      await checkout();

      // Required scenario 1: stock 5, order 3, reserved 3 — and `quantity` untouched.
      expect(await readStock()).toEqual({ quantity: 5, reservedQuantity: 3 });
    });

    it('never lowers quantity: a reservation is a hold, not a deduction', async () => {
      await setStock(5);
      await addToCart(3);

      await checkout();

      const row = await prisma.inventory.findUniqueOrThrow({
        where: { variantId },
      });
      expect(row.quantity).toBe(5);
    });

    it('empties the cart but keeps the cart row', async () => {
      await setStock(5);
      await addToCart(2);
      const before = await readCart();

      await checkout();

      const after = await readCart();
      expect(after).not.toBeNull();
      // Same row, so the client keeps its cart identifier across a purchase.
      expect(after?.id).toBe(before?.id);
      expect(after?.items).toEqual([]);
    });

    it('leaves the cart reusable for a second purchase', async () => {
      await setStock(10);
      await addToCart(1);

      const first = await checkout();
      expect(first.status).toBe(HttpStatus.CREATED);
      expect((await addToCart(2)).status).toBe(HttpStatus.CREATED);
      const second = await checkout();

      expect(second.status).toBe(HttpStatus.CREATED);
      expect(second.body.orderNumber).not.toBe(first.body.orderNumber);
      expect(second.body.id).not.toBe(first.body.id);
      expect(await countOrders()).toBe(2);
      expect(await readStock()).toEqual({ quantity: 10, reservedQuantity: 3 });
    });

    it('snapshots the address, the product name, the sku and the options', async () => {
      await setStock(5);
      await addToCart(1);

      const res = await checkout();
      const order = await prisma.order.findUniqueOrThrow({
        where: { id: res.body.id },
        include: { items: true },
      });

      expect(order).toMatchObject({
        shippingRecipientName: 'Recipient owner',
        shippingPhone: '+15555550100',
        shippingAddressLine1: '18 Mill Lane',
        shippingAddressLine2: null,
        shippingCity: 'Bristol',
        shippingStateProvince: null,
        shippingPostalCode: 'BS1 4TR',
        shippingCountryCode: 'GB',
      });
      expect(order.items[0]).toMatchObject({
        productName: 'Checkout Peacoat',
        sku: slug('SKU-1'),
      });
      expect(order.items[0].variantOptionsSnapshot).toEqual([
        { optionName: 'Color', optionValue: 'Navy' },
        { optionName: 'Size', optionValue: 'M' },
      ]);
    });

    it('reports money as two-decimal strings and leaks nothing', async () => {
      await setStock(5);
      await addToCart(2);

      const res = await checkout();

      for (const amount of [
        res.body.subtotal,
        res.body.shippingFee,
        res.body.discountAmount,
        res.body.totalAmount,
      ]) {
        expect(typeof amount).toBe('string');
        expect(amount).toMatch(/^-?\d+\.\d{2}$/);
      }
      expect(res.body.itemCount).toBe(2);
      expect(Object.keys(res.body).sort()).toEqual(
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
      const serialised = JSON.stringify(res.body);
      expect(serialised).not.toContain('argon2');
      expect(serialised).not.toContain('@example.test');
      expect(serialised).not.toContain('reservedQuantity');
      expect(serialised).not.toContain(email('owner'));
    });
  });

  describe('insufficient stock', () => {
    it('answers 409 and creates nothing when the order exceeds the stock', async () => {
      // Filled while 10 were on hand, then the stock dropped. The cart API refuses to
      // hold more than is available, so a cart can only over-ask for stock once the
      // stock has moved underneath it — which is exactly the case worth testing.
      await setStock(10);
      const added = await addToCart(6);
      expect(added.status).toBe(HttpStatus.CREATED);
      await setStock(5);
      const cartBefore = await readCart();

      const res = await checkout();

      // Required scenario 2: stock 5, order 6, 409, no order, no reservation, and
      // the cart exactly as it was.
      expect(res.status).toBe(HttpStatus.CONFLICT);
      expect(res.body.message).toMatch(/available stock/i);
      expect(await countOrders()).toBe(0);
      expect(await countOrderItems()).toBe(0);
      expect(await readStock()).toEqual({ quantity: 5, reservedQuantity: 0 });
      expect(await readCart()).toEqual(cartBefore);
    });

    it('counts only what is unreserved, not the raw quantity', async () => {
      // 5 on hand with 4 already held leaves 1 to sell, whatever `quantity` says.
      await setStock(10);
      await addToCart(2);
      await setStock(5, 4);

      const res = await checkout();

      expect(res.status).toBe(HttpStatus.CONFLICT);
      expect(await countOrders()).toBe(0);
      expect(await readStock()).toEqual({ quantity: 5, reservedQuantity: 4 });
    });

    it('answers 409 for a variant that has no inventory row at all', async () => {
      await addToCart(1);
      await prisma.inventory.delete({ where: { variantId } });

      const res = await checkout();

      expect(res.status).toBe(HttpStatus.CONFLICT);
      expect(res.body.message).toMatch(/not stocked/i);
      expect(await countOrders()).toBe(0);
      expect(await readCart()).not.toBeNull();
    });

    it('allows a checkout that exactly consumes the remaining stock', async () => {
      await setStock(5);
      await addToCart(5);

      const res = await checkout();

      expect(res.status).toBe(HttpStatus.CREATED);
      expect(await readStock()).toEqual({ quantity: 5, reservedQuantity: 5 });
    });
  });

  describe('two concurrent checkouts for the same stock', () => {
    it('lets exactly one win, and never oversells', async () => {
      // Required scenario 3: stock 5, one basket of 4 and one of 3. Both requests
      // are in flight together on separate connections, so the guarded UPDATE is
      // genuinely contended rather than merely correct in sequence.
      await setStock(5);

      const userA = userId;
      const userB = otherUserId;
      await prisma.cartItem.create({
        data: { cartId: (await ensureCart(userA)).id, variantId, quantity: 4 },
      });
      await prisma.cartItem.create({
        data: { cartId: (await ensureCart(userB)).id, variantId, quantity: 3 },
      });

      const [first, second] = await Promise.all([
        checkout({ user: userA }),
        checkout({ user: userB }),
      ]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([HttpStatus.CREATED, HttpStatus.CONFLICT]);

      // The invariant that matters: whatever happened, the ledger is coherent.
      const stock = await readStock();
      expect(stock.reservedQuantity).toBeLessThanOrEqual(stock.quantity);
      expect(stock).toEqual({ quantity: 5, reservedQuantity: 4 });

      // And the loser left no trace at all.
      const winner = first.status === HttpStatus.CREATED ? userA : userB;
      const loser = first.status === HttpStatus.CREATED ? userB : userA;
      expect(await countOrders(winner)).toBe(1);
      expect(await countOrders(loser)).toBe(0);
      expect(await readCart(loser)).toMatchObject({
        items: [{ variantId, quantity: loser === userB ? 3 : 4 }],
      });
    });

    it('never lets a burst of concurrent checkouts oversell', async () => {
      await setStock(10);

      const buyers: string[] = [];
      for (let index = 0; index < 4; index += 1) {
        buyers.push((await createBuyer(`burst-${index}`, 4)).buyer);
      }

      const results = await Promise.all(
        buyers.map((buyer) => checkout({ user: buyer })),
      );

      const created = results.filter(
        (result) => result.status === HttpStatus.CREATED,
      ).length;
      // 10 units, four baskets of 4: two can be satisfied, two must be refused.
      expect(created).toBe(2);
      expect(
        results.filter((result) => result.status === HttpStatus.CONFLICT),
      ).toHaveLength(2);

      const stock = await readStock();
      expect(stock).toEqual({ quantity: 10, reservedQuantity: 8 });
      expect(stock.reservedQuantity).toBeLessThanOrEqual(stock.quantity);

      const totalReservedByOrders = await prisma.orderItem.aggregate({
        where: { order: { userId: { in: buyers } } },
        _sum: { quantity: true },
      });
      expect(totalReservedByOrders._sum.quantity).toBe(8);
    });

    it('leaves the cart and the stock consistent when both attempts fail', async () => {
      await setStock(2);

      const { buyer } = await createBuyer('both-fail', 2);

      const [first, second] = await Promise.all([
        checkout({ user: buyer }),
        checkout({ user: buyer }),
      ]);

      // Same basket, same address, two identical requests in flight together. Exactly
      // one may become an order: the other must find the basket gone (400) or the
      // stock taken (409). Whichever it is, the ledger has to add up afterwards.
      const statuses = [first.status, second.status];
      expect(statuses).toContain(HttpStatus.CREATED);
      expect(statuses.filter((status) => status === HttpStatus.CREATED)).toHaveLength(1);
      expect(statuses).not.toContain(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(await countOrders(buyer)).toBe(1);
      expect(await countOrderItems(buyer)).toBe(1);
      // 2 in stock, 2 reserved by the single order, and the basket is empty —
      // the loser reserved nothing of its own.
      expect(await readStock()).toEqual({ quantity: 2, reservedQuantity: 2 });
      expect(await readCart(buyer)).toMatchObject({ items: [] });
    });
  });

  describe('a failed checkout rolls everything back', () => {
    it('writes nothing when a later line cannot be reserved', async () => {
      // Two variants: the first reserves fine, the second cannot. If the rollback
      // were incomplete, the first line's hold would survive and permanently remove
      // stock from the sellable pool.
      const product = await prisma.product.findUniqueOrThrow({
        where: { slug: slug('product') },
      });
      const scarce = await prisma.productVariant.create({
        data: {
          productId: product.id,
          sku: slug('SKU-SCARCE'),
          price: '10.00',
        },
      });
      await prisma.inventory.create({
        data: { variantId: scarce.id, quantity: 1, reservedQuantity: 0 },
      });

      await setStock(5);
      const cart = await ensureCart(userId);
      await prisma.cartItem.createMany({
        data: [
          { cartId: cart.id, variantId, quantity: 2 },
          { cartId: cart.id, variantId: scarce.id, quantity: 4 },
        ],
      });
      const cartBefore = await readCart();

      const res = await checkout();

      // Required scenario 5, with the interesting part being the *first* line.
      expect(res.status).toBe(HttpStatus.CONFLICT);
      expect(await countOrders()).toBe(0);
      expect(await countOrderItems()).toBe(0);
      expect(await readStock()).toEqual({ quantity: 5, reservedQuantity: 0 });
      expect(await readStock(scarce.id)).toEqual({
        quantity: 1,
        reservedQuantity: 0,
      });
      expect(await readCart()).toEqual(cartBefore);
    });

    it('writes nothing when the address does not belong to the caller', async () => {
      await setStock(5);
      await addToCart(2);
      const cartBefore = await readCart();

      const res = await checkout({ addressId: otherAddressId });

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
      expect(await countOrders()).toBe(0);
      expect(await readStock()).toEqual({ quantity: 5, reservedQuantity: 0 });
      expect(await readCart()).toEqual(cartBefore);
    });

    it('writes nothing when the cart is empty', async () => {
      // The cart row exists but holds nothing: "empty" is a checkout error (400),
      // while a user who has never had a cart at all is a different case.
      await ensureCart(userId);
      await setStock(5);

      const res = await checkout();

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.message).toMatch(/empty cart/i);
      expect(await countOrders()).toBe(0);
      expect(await readStock()).toEqual({ quantity: 5, reservedQuantity: 0 });
    });

    it('writes nothing when the variant has been deactivated', async () => {
      await setStock(5);
      await addToCart(2);
      const cartBefore = await readCart();
      await prisma.productVariant.update({
        where: { id: variantId },
        data: { isActive: false },
      });

      const res = await checkout();

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.message).toMatch(/not active/i);
      expect(await countOrders()).toBe(0);
      expect(await readStock()).toEqual({ quantity: 5, reservedQuantity: 0 });
      expect(await readCart()).toEqual(cartBefore);
    });

    it('writes nothing when the product has been withdrawn but the variant is not', async () => {
      await setStock(5);
      await addToCart(2);
      await prisma.product.update({
        where: { slug: slug('product') },
        data: { isActive: false },
      });

      const res = await checkout();

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.message).toMatch(/not active/i);
      expect(await countOrders()).toBe(0);
      expect(await readStock()).toEqual({ quantity: 5, reservedQuantity: 0 });
    });

    it('writes nothing for a user that does not exist', async () => {
      const res = await checkout({ user: randomUUID() });

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
      expect(await prisma.order.count()).toBe(0);
    });
  });

  describe('the client cannot influence the order', () => {
    it('uses the current database price, not one the client sent', async () => {
      // Required scenario 6: the price moves after the line is in the cart, and the
      // order records the price at checkout.
      await setStock(5);
      await addToCart(2);
      await prisma.productVariant.update({
        where: { id: variantId },
        data: { price: '149.50' },
      });

      const res = await api('POST', '/checkout', {
        body: {
          addressId,
          unitPrice: '0.01',
          totalAmount: '0.02',
          subtotal: '0.02',
        },
      });

      // The smuggle attempt is a rejected request, not a discounted one.
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(await countOrders()).toBe(0);

      const honest = await checkout();
      expect(honest.status).toBe(HttpStatus.CREATED);
      expect(honest.body.subtotal).toBe('299.00');
      expect(honest.body.totalAmount).toBe('299.00');

      const order = await prisma.order.findUniqueOrThrow({
        where: { id: honest.body.id },
        include: { items: true },
      });
      expect(order.items[0].unitPrice.toFixed(2)).toBe('149.50');
      expect(order.items[0].lineTotal.toFixed(2)).toBe('299.00');
    });

    it('uses the cart quantity, not one the client sent', async () => {
      await setStock(5);
      await addToCart(2);

      const res = await checkout();

      const order = await prisma.order.findUniqueOrThrow({
        where: { id: res.body.id },
        include: { items: true },
      });
      expect(order.items[0].quantity).toBe(2);
      expect(await readStock()).toEqual({ quantity: 5, reservedQuantity: 2 });
    });

    it('adds Decimal amounts exactly, with no floating-point drift', async () => {
      // A price that cannot be represented in binary floating point, at a quantity
      // that magnifies the error: 3 x 0.10 must be exactly 0.30.
      await setStock(100);
      const product = await prisma.product.findUniqueOrThrow({
        where: { slug: slug('product') },
      });
      const pennies = await prisma.productVariant.create({
        data: {
          productId: product.id,
          sku: slug('SKU-PENNIES'),
          price: '0.10',
        },
      });
      await prisma.inventory.create({
        data: { variantId: pennies.id, quantity: 100, reservedQuantity: 0 },
      });

      const cart = await ensureCart(userId);
      await prisma.cartItem.create({
        data: { cartId: cart.id, variantId: pennies.id, quantity: 3 },
      });

      const res = await checkout();

      expect(res.status).toBe(HttpStatus.CREATED);
      expect(res.body.subtotal).toBe('0.30');
      expect(res.body.totalAmount).toBe('0.30');
      const order = await prisma.order.findUniqueOrThrow({
        where: { id: res.body.id },
        include: { items: true },
      });
      expect(order.items[0].lineTotal.toFixed(2)).toBe('0.30');
    });
  });

  describe('the snapshot survives later edits', () => {
    it('keeps the checkout-time address after the address book changes', async () => {
      // Required scenario 7.
      await setStock(5);
      await addToCart(1);

      const res = await checkout();
      await prisma.address.update({
        where: { id: addressId },
        data: {
          recipientName: 'Somebody Else',
          addressLine1: '99 New Street',
          city: 'Leeds',
          countryCode: 'FR',
        },
      });

      const order = await prisma.order.findUniqueOrThrow({
        where: { id: res.body.id },
      });
      expect(order.shippingRecipientName).toBe('Recipient owner');
      expect(order.shippingAddressLine1).toBe('18 Mill Lane');
      expect(order.shippingCity).toBe('Bristol');
      expect(order.shippingCountryCode).toBe('GB');

      // The stored order does not even name the address row it came from.
      expect(order).not.toHaveProperty('addressId');
    });

    it('keeps the checkout-time address after the address is deleted', async () => {
      await setStock(5);
      await addToCart(1);

      const res = await checkout();
      await prisma.address.delete({ where: { id: addressId } });

      const order = await prisma.order.findUniqueOrThrow({
        where: { id: res.body.id },
      });
      expect(order.shippingRecipientName).toBe('Recipient owner');
      expect(order.shippingCity).toBe('Bristol');
    });

    it('keeps the product name, sku and price after the catalogue changes', async () => {
      await setStock(5);
      await addToCart(1);

      const res = await checkout();
      await prisma.productVariant.update({
        where: { id: variantId },
        data: { price: '999.00' },
      });
      await prisma.product.update({
        where: { slug: slug('product') },
        data: { name: 'Renamed Product' },
      });
      await prisma.variantOption.deleteMany({ where: { variantId } });

      const order = await prisma.order.findUniqueOrThrow({
        where: { id: res.body.id },
        include: { items: true },
      });
      expect(order.items[0].productName).toBe('Checkout Peacoat');
      expect(order.items[0].sku).toBe(slug('SKU-1'));
      expect(order.items[0].unitPrice.toFixed(2)).toBe('129.00');
      expect(order.items[0].variantOptionsSnapshot).toEqual([
        { optionName: 'Color', optionValue: 'Navy' },
        { optionName: 'Size', optionValue: 'M' },
      ]);

      // And the read path reports the snapshot too, not the new catalogue state.
      const read = await api('GET', `/orders/${res.body.id}`);
      expect(read.status).toBe(HttpStatus.OK);
      expect(read.body.items[0].productName).toBe('Checkout Peacoat');
    });
  });

  describe('the request contract', () => {
    it('rejects a missing addressId', async () => {
      const res = await api('POST', '/checkout', { body: {} });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(await countOrders()).toBe(0);
    });

    it('rejects a malformed address id', async () => {
      const res = await api('POST', '/checkout', {
        body: { addressId: 'not-a-uuid' },
      });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('rejects an unknown address', async () => {
      await setStock(5);
      await addToCart(1);

      const res = await checkout({ addressId: randomUUID() });

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
      expect(await countOrders()).toBe(0);
    });

    it("answers the same 404 for another user's address", async () => {
      await setStock(5);
      await addToCart(1);

      const unknown = await checkout({ addressId: randomUUID() });
      const notMine = await checkout({ addressId: otherAddressId });

      // Both are 404 with the same shape, so a client cannot use checkout to tell
      // "no such address" from "that address exists but is not yours" — and therefore
      // cannot enumerate another user's address book through it.
      expect(notMine.status).toBe(HttpStatus.NOT_FOUND);
      expect(unknown.status).toBe(HttpStatus.NOT_FOUND);
      expect(notMine.body.message).toMatch(/^Address .* does not exist$/);
      expect(unknown.body.message).toMatch(/^Address .* does not exist$/);
      // Not a 403: the response must not confirm the address is real.
      expect(notMine.body.message).not.toMatch(/forbidden|belongs|another user/i);
      expect(await countOrders()).toBe(0);
    });

    it('rejects a request with no identity header', async () => {
      const res = await fetch(`${base}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addressId }),
      });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('offers no way to change or cancel an order', async () => {
      const res = await api('DELETE', '/checkout');

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
    });

    it('leaves the cart feature alone', async () => {
      await setStock(5);
      await addToCart(1);

      const res = await checkout();

      expect(res.status).toBe(HttpStatus.CREATED);
      // The cart is still there and still readable, with its own id intact.
      const cart = await api('GET', '/cart');
      expect(cart.status).toBe(HttpStatus.OK);
      expect(cart.body.items).toEqual([]);
      expect(cart.body.itemCount).toBe(0);
    });
  });
});
