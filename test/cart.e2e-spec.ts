import 'dotenv/config';
import {
  HttpStatus,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { Prisma } from '../src/generated/prisma/client.js';
import { CartModule } from '../src/cart/cart.module.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { TEMPORARY_USER_ID_HEADER } from '../src/common/decorators/temporary-user-id.decorator.js';

/**
 * Cart behaviour against a **real PostgreSQL** database.
 *
 * The unit specs pin the rules the service intends; this file proves the rules
 * survive contact with the database, which is the only way to check the parts
 * that are the database's job:
 *
 * - the `CHECK (quantity > 0)` and the unique `(cart_id, variant_id)` index
 *   really do reject what the service promises to reject;
 * - `ON DELETE CASCADE` really does remove a user's cart and its lines;
 * - `ON DELETE RESTRICT` really does refuse to delete a variant a customer is
 *   holding;
 * - two concurrent adds of the same variant really do converge on one line with
 *   the summed quantity instead of two rows or a 500.
 *
 * Nothing is mocked. Every fixture is written through the same tables the
 * application uses, so a change that quietly breaks a constraint fails here.
 *
 * It runs as part of `npm test` (and `npm run test:e2e`) and needs a reachable
 * `DATABASE_URL`. Fixtures are namespaced by a per-run token and torn down in
 * `afterAll`, so repeated runs never collide.
 */
describe('Cart (PostgreSQL)', () => {
  const run = randomUUID().slice(0, 8);
  const email = (name: string) => `cart-${run}-${name}@example.test`;
  const slug = (name: string) => `cart-${run}-${name}`;

  let app: INestApplication;
  let prisma: PrismaService;
  let base: string;
  let userId: string;
  let otherUserId: string;
  let variantId: string;
  let otherVariantId: string;

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

  const getCart = async (id: string) =>
    (await api('GET', '/cart', { user: id })).body;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        'DATABASE_URL is not set — the cart integration tests need a real PostgreSQL instance',
      );
    }

    const module: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule, CartModule],
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
      data: { name: `Cart ${run}`, slug: slug('category') },
    });

    const createUser = async (name: string) =>
      prisma.user.create({
        data: {
          firstName: 'Cart',
          lastName: 'Tester',
          email: email(name),
          // A real hash is irrelevant here; nothing logs in during these tests.
          passwordHash: 'argon2-not-a-real-hash',
          status: 'ACTIVE',
        },
      });

    userId = (await createUser('owner')).id;
    otherUserId = (await createUser('other')).id;

    const createVariant = async (name: string, quantity: number) => {
      const product = await prisma.product.create({
        data: {
          categoryId: category.id,
          name: `Cart product ${name}`,
          slug: slug(`product-${name}`),
          basePrice: '19.99',
          status: 'ACTIVE',
        },
      });
      const variant = await prisma.productVariant.create({
        data: {
          productId: product.id,
          sku: slug(`SKU-${name}`),
          price: '19.99',
        },
      });
      await prisma.inventory.create({
        data: { variantId: variant.id, quantity },
      });

      return variant.id;
    };

    variantId = await createVariant('main', 10);
    otherVariantId = await createVariant('other', 3);
  });

  afterAll(async () => {
    if (prisma === undefined) {
      return;
    }

    // Cart lines reference variants with ON DELETE RESTRICT, so the carts have to
    // go first — which is itself the delete order the schema implies.
    await prisma.cartItem.deleteMany({});
    await prisma.cart.deleteMany({});
    await prisma.user.deleteMany({
      where: { email: { startsWith: `cart-${run}-` } },
    });
    await prisma.product.deleteMany({
      where: { slug: { startsWith: `cart-${run}-` } },
    });
    await prisma.category.deleteMany({
      where: { slug: slug('category') },
    });

    await app.close();
  });

  it('creates the cart on the first read and keeps it afterwards', async () => {
    const first = await api('GET', '/cart');
    expect(first.status).toBe(HttpStatus.OK);
    expect(first.body).toMatchObject({ userId, items: [], itemCount: 0 });
    expect(first.body.subtotal).toBe('0.00');

    const second = await getCart(userId);
    expect(second.id).toBe(first.body.id);
  });

  it('adds a line and reports the current catalog and stock', async () => {
    const res = await api('POST', '/cart/items', {
      body: { variantId, quantity: 2 },
    });

    expect(res.status).toBe(HttpStatus.CREATED);
    expect(res.body).toMatchObject({
      variantId,
      quantity: 2,
      available: 10,
      exceedsAvailable: false,
      unitPrice: '19.99',
      lineTotal: '39.98',
      variant: { id: variantId, isActive: true },
      product: { isActive: true },
    });

    const cart = await getCart(userId);
    expect(cart.items).toHaveLength(1);
    expect(cart.itemCount).toBe(2);
    expect(cart.subtotal).toBe('39.98');
    expect(JSON.stringify(cart)).not.toContain('passwordHash');
  });

  it('increments the existing line when the same variant is added twice', async () => {
    await api('POST', '/cart/items', { body: { variantId, quantity: 1 } });

    const cart = await getCart(userId);
    expect(cart.items).toHaveLength(1);
    expect(cart.items[0].quantity).toBe(3);
    expect(cart.subtotal).toBe('59.97');
  });

  it('keeps a second variant on its own line', async () => {
    await api('POST', '/cart/items', {
      body: { variantId: otherVariantId, quantity: 1 },
    });

    const cart = await getCart(userId);
    expect(cart.items).toHaveLength(2);
    expect(cart.itemCount).toBe(4);
    expect(cart.subtotal).toBe('79.96');
  });

  it('updates the quantity of a line to an absolute value', async () => {
    const cart = await getCart(userId);
    const line = cart.items.find(
      (item: { variantId: string }) => item.variantId === variantId,
    );

    const res = await api('PATCH', `/cart/items/${line.id}`, {
      body: { quantity: 5 },
    });

    expect(res.status).toBe(HttpStatus.OK);
    expect(res.body.quantity).toBe(5);
    expect(res.body.lineTotal).toBe('99.95');

    const after = await getCart(userId);
    expect(after.subtotal).toBe('119.94');
  });

  it('removes one line and leaves the other', async () => {
    const cart = await getCart(userId);
    const line = cart.items.find(
      (item: { variantId: string }) => item.variantId === otherVariantId,
    );

    const res = await api('DELETE', `/cart/items/${line.id}`);

    expect(res.status).toBe(HttpStatus.NO_CONTENT);
    expect(res.body).toBeUndefined();

    const after = await getCart(userId);
    expect(after.items).toHaveLength(1);
    expect(after.items[0].variantId).toBe(variantId);
  });

  it('empties the cart while keeping the cart row and its id', async () => {
    const before = await getCart(userId);

    const res = await api('DELETE', '/cart');
    expect(res.status).toBe(HttpStatus.NO_CONTENT);
    expect(res.body).toBeUndefined();

    const after = await getCart(userId);
    expect(after.id).toBe(before.id);
    expect(after.items).toEqual([]);
    expect(after.subtotal).toBe('0.00');
  });

  it('clearing an already empty cart is a 204, not an error', async () => {
    const res = await api('DELETE', '/cart');
    expect(res.status).toBe(HttpStatus.NO_CONTENT);
  });

  it('gives each user its own cart', async () => {
    await api('POST', '/cart/items', { body: { variantId, quantity: 1 } });

    const mine = await getCart(userId);
    const theirs = await getCart(otherUserId);

    expect(mine.items).toHaveLength(1);
    expect(theirs.items).toEqual([]);
    expect(theirs.id).not.toBe(mine.id);
  });

  describe('ownership is not probeable', () => {
    it('another user patching my line → 404', async () => {
      const mine = await getCart(userId);

      const res = await api('PATCH', `/cart/items/${mine.items[0].id}`, {
        user: otherUserId,
        body: { quantity: 2 },
      });

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
    });

    it('another user deleting my line → 404 and the line survives', async () => {
      const mine = await getCart(userId);

      const res = await api('DELETE', `/cart/items/${mine.items[0].id}`, {
        user: otherUserId,
      });

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
      expect((await getCart(userId)).items).toHaveLength(1);
    });

    it('a well-formed id that does not exist → 404', async () => {
      const res = await api('DELETE', `/cart/items/${randomUUID()}`);
      expect(res.status).toBe(HttpStatus.NOT_FOUND);
    });

    it('a malformed id → 400 before any lookup', async () => {
      const res = await api('DELETE', '/cart/items/not-a-uuid');
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('an unknown but well-formed user → 404', async () => {
      const res = await api('GET', '/cart', { user: randomUUID() });
      expect(res.status).toBe(HttpStatus.NOT_FOUND);
    });
  });

  describe('rejected adds', () => {
    it('an inactive variant → 400', async () => {
      await prisma.productVariant.update({
        where: { id: otherVariantId },
        data: { isActive: false },
      });

      const res = await api('POST', '/cart/items', {
        body: { variantId: otherVariantId, quantity: 1 },
      });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('a missing variant → 404', async () => {
      const res = await api('POST', '/cart/items', {
        body: { variantId: randomUUID(), quantity: 1 },
      });

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
    });

    it('a variant without an inventory row → 404', async () => {
      const product = await prisma.product.create({
        data: {
          categoryId: (await prisma.category.findFirstOrThrow()).id,
          name: 'Unstocked',
          slug: slug('product-unstocked'),
          basePrice: '5.00',
          status: 'ACTIVE',
        },
      });
      const variant = await prisma.productVariant.create({
        data: {
          productId: product.id,
          sku: slug('SKU-unstocked'),
          price: '5.00',
        },
      });

      const res = await api('POST', '/cart/items', {
        body: { variantId: variant.id, quantity: 1 },
      });

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
    });

    it('more than the available stock → 409 and nothing is written', async () => {
      const res = await api('POST', '/cart/items', {
        body: { variantId, quantity: 11 },
      });

      expect(res.status).toBe(HttpStatus.CONFLICT);
      expect((await getCart(userId)).itemCount).toBe(1);
    });

    it('a total beyond available is rejected, not the bare increment', async () => {
      const line = (await getCart(userId)).items[0];
      await api('PATCH', `/cart/items/${line.id}`, { body: { quantity: 8 } });

      const res = await api('POST', '/cart/items', {
        body: { variantId, quantity: 5 },
      });

      expect(res.status).toBe(HttpStatus.CONFLICT);
      expect((await getCart(userId)).items[0].quantity).toBe(8);
    });

    it('zero, negative and fractional quantities → 400', async () => {
      for (const quantity of [0, -1, 1.5]) {
        const res = await api('POST', '/cart/items', {
          body: { variantId, quantity },
        });

        expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      }
    });
  });

  describe('stock may move after the fact — nothing is reserved', () => {
    it('reserved_quantity is untouched by every cart operation', async () => {
      await prisma.inventory.update({
        where: { variantId },
        data: { quantity: 12, reservedQuantity: 0 },
      });

      await api('POST', '/cart/items', { body: { variantId, quantity: 2 } });
      await api('DELETE', '/cart');

      const inventory = await prisma.inventory.findUniqueOrThrow({
        where: { variantId },
      });
      expect(inventory.reservedQuantity).toBe(0);
    });

    it('a later stock drop shows up as a smaller available, flagged', async () => {
      await prisma.inventory.update({
        where: { variantId },
        data: { quantity: 12 },
      });
      await api('POST', '/cart/items', { body: { variantId, quantity: 9 } });

      await prisma.inventory.update({
        where: { variantId },
        data: { quantity: 4, reservedQuantity: 1 },
      });

      const item = (await getCart(userId)).items[0];
      expect(item.available).toBe(3);
      expect(item.exceedsAvailable).toBe(true);
      expect(item.quantity).toBe(9);
    });
  });

  describe('database constraints are the final protection', () => {
    it('rejects a duplicate (cart_id, variant_id) row outright', async () => {
      const cart = await prisma.cart.findUniqueOrThrow({
        where: { userId },
      });

      await expect(
        prisma.cartItem.create({
          data: { cartId: cart.id, variantId, quantity: 1 },
        }),
      ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    });

    it('rejects quantity zero and negative quantities', async () => {
      const cart = await prisma.cart.findUniqueOrThrow({
        where: { userId },
      });

      for (const quantity of [0, -3]) {
        await expect(
          prisma.cartItem.create({
            data: { cartId: cart.id, variantId: otherVariantId, quantity },
          }),
        ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      }
    });

    it('rejects a second cart for the same user', async () => {
      await expect(
        prisma.cart.create({ data: { userId } }),
      ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    });
  });

  describe('concurrent adds', () => {
    it('converges on one line with the summed quantity', async () => {
      await api('DELETE', '/cart');
      await prisma.inventory.update({
        where: { variantId },
        data: { quantity: 20, reservedQuantity: 0 },
      });

      const [first, second, third] = await Promise.all([
        api('POST', '/cart/items', { body: { variantId, quantity: 2 } }),
        api('POST', '/cart/items', { body: { variantId, quantity: 3 } }),
        api('POST', '/cart/items', { body: { variantId, quantity: 5 } }),
      ]);

      expect([first.status, second.status, third.status]).toEqual([
        HttpStatus.CREATED,
        HttpStatus.CREATED,
        HttpStatus.CREATED,
      ]);

      const rows = await prisma.cartItem.count({
        where: {
          cartId: (await prisma.cart.findUniqueOrThrow({ where: { userId } }))
            .id,
          variantId,
        },
      });
      expect(rows).toBe(1);

      const cart = await getCart(userId);
      expect(cart.items[0].quantity).toBe(10);
    });

    it('never oversells when concurrent adds together exceed the stock', async () => {
      await api('DELETE', '/cart');
      await prisma.inventory.update({
        where: { variantId },
        data: { quantity: 5, reservedQuantity: 0 },
      });

      const results = await Promise.all([
        api('POST', '/cart/items', { body: { variantId, quantity: 3 } }),
        api('POST', '/cart/items', { body: { variantId, quantity: 3 } }),
      ]);

      expect(results.map((result) => result.status).sort()).toEqual(
        [HttpStatus.CREATED, HttpStatus.CONFLICT].sort(),
      );

      const cart = await getCart(userId);
      expect(cart.items).toHaveLength(1);
      expect(cart.items[0].quantity).toBeLessThanOrEqual(5);
    });

    it('concurrent first reads create exactly one cart', async () => {
      const freshUser = await prisma.user.create({
        data: {
          firstName: 'Cart',
          lastName: 'Racer',
          email: email('racer'),
          passwordHash: 'argon2-not-a-real-hash',
          status: 'ACTIVE',
        },
      });

      const carts = await Promise.all([
        api('GET', '/cart', { user: freshUser.id }),
        api('GET', '/cart', { user: freshUser.id }),
        api('GET', '/cart', { user: freshUser.id }),
      ]);

      expect(carts.map((result) => result.status)).toEqual([
        HttpStatus.OK,
        HttpStatus.OK,
        HttpStatus.OK,
      ]);
      expect(new Set(carts.map((result) => result.body.id)).size).toBe(1);
      expect(await prisma.cart.count({ where: { userId: freshUser.id } })).toBe(
        1,
      );
    });
  });

  describe('deletion behaviour', () => {
    it('deleting the user cascades to the cart and its lines', async () => {
      const doomed = await prisma.user.create({
        data: {
          firstName: 'Cart',
          lastName: 'Doomed',
          email: email('doomed'),
          passwordHash: 'argon2-not-a-real-hash',
          status: 'ACTIVE',
        },
      });
      await api('POST', '/cart/items', {
        user: doomed.id,
        body: { variantId, quantity: 1 },
      });

      await prisma.user.delete({ where: { id: doomed.id } });

      expect(await prisma.cart.count({ where: { userId: doomed.id } })).toBe(0);
      expect(
        await prisma.cartItem.count({ where: { cartId: doomed.id } }),
      ).toBe(0);
    });

    it('refuses to delete a variant a cart still references', async () => {
      await api('POST', '/cart/items', { body: { variantId, quantity: 1 } });

      await expect(
        prisma.productVariant.delete({ where: { id: variantId } }),
      ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    });

    it('refuses to delete the product behind a referenced variant', async () => {
      const product = await prisma.product.findFirstOrThrow({
        where: { variants: { some: { id: variantId } } },
      });

      await expect(
        prisma.product.delete({ where: { id: product.id } }),
      ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    });

    it('allows the deletion once the cart no longer holds the variant', async () => {
      await api('DELETE', '/cart');
      await prisma.cartItem.deleteMany({});

      await expect(
        prisma.productVariant.delete({ where: { id: variantId } }),
      ).resolves.toMatchObject({ id: variantId });

      // Put the shared fixture back so ordering between tests cannot matter.
      const product = await prisma.product.findFirstOrThrow({
        where: { slug: slug('product-main') },
      });
      const restored = await prisma.productVariant.create({
        data: { productId: product.id, sku: slug('SKU-main'), price: '19.99' },
      });
      await prisma.inventory.create({
        data: { variantId: restored.id, quantity: 20, reservedQuantity: 0 },
      });
      variantId = restored.id;
    });
  });
});
