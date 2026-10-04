import 'dotenv/config';
import {
  HttpStatus,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { Prisma } from '../src/generated/prisma/client.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { TEMPORARY_USER_ID_HEADER } from '../src/common/decorators/temporary-user-id.decorator.js';
import { WishlistModule } from '../src/wishlist/wishlist.module.js';

/**
 * Wishlist behaviour against a **real PostgreSQL** database.
 *
 * The unit specs pin the rules the service intends; this file proves the rules
 * survive contact with the database, which is the only way to check the parts that
 * are the database's job:
 *
 * - the unique `(wishlist_id, product_id)` index really does make two concurrent
 *   saves of the same product converge on one row instead of two rows or a 500;
 * - the unique `wishlists.user_id` index really does settle a concurrent
 *   first-request race;
 * - `ON DELETE CASCADE` really does remove a user's wishlist and its entries;
 * - `ON DELETE RESTRICT` really does refuse to delete a product a customer saved.
 *
 * Nothing is mocked. Every fixture is written through the same tables the
 * application uses, so a change that quietly breaks a constraint fails here.
 *
 * It runs as part of `npm run test:e2e` and needs a reachable `DATABASE_URL`.
 * Fixtures are namespaced by a per-run token and torn down in `afterAll`, so
 * repeated runs never collide.
 */
describe('Wishlist (PostgreSQL)', () => {
  const run = randomUUID().slice(0, 8);
  const email = (name: string) => `wish-${run}-${name}@example.test`;
  const slug = (name: string) => `wish-${run}-${name}`;

  let app: INestApplication;
  let prisma: PrismaService;
  let base: string;
  let userId: string;
  let otherUserId: string;
  let categoryId: string;
  /** Active, one primary image, two active variants at different prices. */
  let productId: string;
  let otherProductId: string;
  /** Saved-then-deactivated product. */
  let inactiveProductId: string;
  /** No image, no active variant. */
  let bareProductId: string;
  /** Active product whose only variant is sold out. */
  let soldOutProductId: string;

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

  const getWishlist = async (id: string) =>
    (await api('GET', '/wishlist', { user: id })).body;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        'DATABASE_URL is not set — the wishlist integration tests need a real PostgreSQL instance',
      );
    }

    const module: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule, WishlistModule],
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
      data: { name: `Wishlist ${run}`, slug: slug('category') },
    });
    categoryId = category.id;

    const createUser = async (name: string) =>
      (
        await prisma.user.create({
          data: {
            firstName: 'Wish',
            lastName: 'Tester',
            email: email(name),
            // A real hash is irrelevant here; nothing logs in during these tests.
            passwordHash: 'argon2-not-a-real-hash',
            status: 'ACTIVE',
          },
        })
      ).id;

    userId = await createUser('owner');
    otherUserId = await createUser('other');

    /**
     * Creates a product with one active variant (and optionally a second), one
     * primary image, and a matching inventory row per variant.
     */
    const createProduct = async (
      name: string,
      options: {
        isActive?: boolean;
        status?: string;
        withImage?: boolean;
        variantPrices?: { sku: string; price: string; stock: number }[];
        secondaryPrice?: { sku: string; price: string; stock: number };
      } = {},
    ) => {
      const {
        isActive = true,
        status = 'ACTIVE',
        withImage = false,
        variantPrices = [{ sku: 'ONE', price: '19.99', stock: 5 }],
        secondaryPrice,
      } = options;

      const product = await prisma.product.create({
        data: {
          categoryId,
          name: `Wish product ${name}`,
          slug: slug(`product-${name}`),
          basePrice: variantPrices[0].price,
          status,
          isActive,
        },
      });

      if (withImage) {
        await prisma.productImage.create({
          data: {
            productId: product.id,
            imageUrl: `https://cdn.example.test/${slug(`img-${name}`)}.jpg`,
            publicId: slug(`public-${name}`),
            altText: `${name} front`,
            sortOrder: 0,
            isPrimary: true,
          },
        });
      }

      for (const variant of [
        ...variantPrices,
        ...(secondaryPrice === undefined ? [] : [secondaryPrice]),
      ]) {
        const created = await prisma.productVariant.create({
          data: {
            productId: product.id,
            sku: slug(`SKU-${name}-${variant.sku}`),
            price: variant.price,
          },
        });
        await prisma.inventory.create({
          data: { variantId: created.id, quantity: variant.stock },
        });
      }

      return product.id;
    };

    productId = await createProduct('main', {
      withImage: true,
      variantPrices: [{ sku: 'ONE', price: '19.99', stock: 5 }],
      secondaryPrice: { sku: 'TWO', price: '10.00', stock: 2 },
    });
    otherProductId = await createProduct('other');
    inactiveProductId = await createProduct('inactive', {
      isActive: false,
      status: 'ARCHIVED',
    });
    bareProductId = await createProduct('bare');
    soldOutProductId = await createProduct('soldout', {
      variantPrices: [{ sku: 'ONE', price: '7.50', stock: 0 }],
    });

    // An inactive variant must not surface on the wishlist even though its product
    // is active, so deactivate the sold-out product's only variant's sibling.
    await prisma.productVariant.updateMany({
      where: { productId: bareProductId },
      data: { isActive: false },
    });
  });

  afterAll(async () => {
    if (prisma === undefined) {
      return;
    }

    // Every user this file creates shares the run prefix, so the cleanup below is
    // scoped to those rows alone. Deleting wishlists and products unconditionally
    // would reach into whatever else is in the database.
    const myUsers = { email: { startsWith: `wish-${run}-` } };
    const myProducts = { slug: { startsWith: `wish-${run}-` } };

    try {
      // Deleting a wishlist cascades to its entries, and wishlist entries reference
      // products with ON DELETE RESTRICT, so this order is also the order the schema
      // implies for real deletions.
      await prisma.wishlist.deleteMany({ where: { user: myUsers } });
      await prisma.user.deleteMany({ where: myUsers });
      await prisma.product.deleteMany({ where: myProducts });
      await prisma.category.deleteMany({ where: { id: categoryId } });
    } finally {
      // Close even if cleanup threw. A leaked Nest app holding a Prisma pool is
      // reported as a suite-level failure with every test already green, which
      // hides the error that actually caused it.
      await app.close();
    }
  });

  describe('reading', () => {
    it('creates the wishlist on the first read and keeps it afterwards', async () => {
      const first = await api('GET', '/wishlist');

      expect(first.status).toBe(HttpStatus.OK);
      expect(first.body).toMatchObject({ userId, items: [], itemCount: 0 });
      expect(await prisma.wishlist.count({ where: { userId } })).toBe(1);

      const second = await getWishlist(userId);
      expect(second.id).toBe(first.body.id);
    });

    it('never exposes the owning user row', async () => {
      const wishlist = await getWishlist(userId);

      expect(JSON.stringify(wishlist)).not.toContain('passwordHash');
      expect(Object.keys(wishlist).sort()).toEqual(
        ['createdAt', 'id', 'itemCount', 'items', 'updatedAt', 'userId'].sort(),
      );
    });

    it('gives each user their own wishlist', async () => {
      await api('POST', '/wishlist/items', {
        body: { productId },
      });

      const mine = await getWishlist(userId);
      const theirs = await getWishlist(otherUserId);

      expect(mine.items).toHaveLength(1);
      expect(theirs.items).toEqual([]);
      expect(theirs.id).not.toBe(mine.id);
    });
  });

  describe('saving a product', () => {
    it('returns 201 with the current product information', async () => {
      const res = await api('POST', '/wishlist/items', {
        body: { productId: otherProductId },
      });

      expect(res.status).toBe(HttpStatus.CREATED);
      expect(res.body).toMatchObject({ productId: otherProductId });
      expect(Object.keys(res.body).sort()).toEqual(
        ['createdAt', 'id', 'product', 'productId', 'wishlistId'].sort(),
      );
      expect(res.body.product).toMatchObject({
        id: otherProductId,
        isActive: true,
        status: 'ACTIVE',
        basePrice: '19.99',
        priceRange: { min: '19.99', max: '19.99' },
        inStock: true,
      });
      expect(res.body.product.image).toBeNull();
    });

    it('exposes the primary image and the variant price range', async () => {
      const res = await api('POST', '/wishlist/items', {
        body: { productId },
      });

      expect(res.body.product.image).toMatchObject({
        imageUrl: `https://cdn.example.test/${slug('img-main')}.jpg`,
        altText: 'main front',
      });
      // "10.00" < "19.99" numerically, and would compare the other way as text.
      expect(res.body.product.priceRange).toEqual({
        min: '10.00',
        max: '19.99',
      });
      expect(res.body.product.variants).toHaveLength(2);
      expect(res.body.product.variants[0].options).toEqual([]);
    });

    it('reports a sold-out product as unavailable', async () => {
      const res = await api('POST', '/wishlist/items', {
        body: { productId: soldOutProductId },
      });

      expect(res.body.product.inStock).toBe(false);
      expect(res.body.product.variants[0].available).toBe(0);
    });

    it('reports a product with no active variant as neither priced nor stocked', async () => {
      const res = await api('POST', '/wishlist/items', {
        body: { productId: bareProductId },
      });

      expect(res.body.product.variants).toEqual([]);
      expect(res.body.product.priceRange).toBeNull();
      expect(res.body.product.inStock).toBe(false);
    });

    it('saves a deactivated product rather than refusing it', async () => {
      const res = await api('POST', '/wishlist/items', {
        body: { productId: inactiveProductId },
      });

      expect(res.status).toBe(HttpStatus.CREATED);
      expect(res.body.product.isActive).toBe(false);
      expect(res.body.product.status).toBe('ARCHIVED');
    });

    it('saving the same product twice returns the same entry', async () => {
      const first = await api('POST', '/wishlist/items', {
        body: { productId },
      });
      const second = await api('POST', '/wishlist/items', {
        body: { productId },
      });

      expect(second.status).toBe(HttpStatus.CREATED);
      expect(second.body.id).toBe(first.body.id);

      const rows = await prisma.wishlistItem.count({
        where: { wishlist: { userId }, productId },
      });
      expect(rows).toBe(1);
    });

    it('rejects a product that does not exist', async () => {
      const res = await api('POST', '/wishlist/items', {
        body: { productId: randomUUID() },
      });

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
    });

    it('rejects malformed and surplus input', async () => {
      const before = await prisma.wishlistItem.count({});

      for (const body of [
        {},
        { productId: 'not-a-uuid' },
        { productId, quantity: 2 },
        { productId, wishlistId: randomUUID() },
        { productId, isActive: false },
      ]) {
        const res = await api('POST', '/wishlist/items', { body });

        expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      }

      // A rejected request must leave no trace, not even a row with the extra
      // field quietly dropped.
      expect(await prisma.wishlistItem.count({})).toBe(before);
    });

    it('rejects an unknown or malformed user', async () => {
      expect(
        (await api('GET', '/wishlist', { user: randomUUID() })).status,
      ).toBe(HttpStatus.NOT_FOUND);

      const res = await fetch(`${base}/wishlist`, { method: 'GET' });
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });
  });

  describe('concurrent saves', () => {
    it('converges on one row when the same product is saved at the same time', async () => {
      const target = slug('racy');
      const product = await prisma.product.create({
        data: {
          categoryId,
          name: 'Racy',
          slug: target,
          basePrice: '5.00',
          status: 'ACTIVE',
        },
      });

      const results = await Promise.all(
        [1, 2, 3, 4, 5].map(() =>
          api('POST', '/wishlist/items', {
            user: otherUserId,
            body: { productId: product.id },
          }),
        ),
      );

      expect(results.map((result) => result.status)).toEqual([
        HttpStatus.CREATED,
        HttpStatus.CREATED,
        HttpStatus.CREATED,
        HttpStatus.CREATED,
        HttpStatus.CREATED,
      ]);
      expect(new Set(results.map((result) => result.body.id)).size).toBe(1);
      expect(
        await prisma.wishlistItem.count({
          where: { wishlist: { userId: otherUserId }, productId: product.id },
        }),
      ).toBe(1);
    });

    it('creates exactly one wishlist for concurrent first reads', async () => {
      const racer = await prisma.user.create({
        data: {
          firstName: 'Wish',
          lastName: 'Racer',
          email: email('racer'),
          passwordHash: 'argon2-not-a-real-hash',
          status: 'ACTIVE',
        },
      });

      const results = await Promise.all([
        api('GET', '/wishlist', { user: racer.id }),
        api('GET', '/wishlist', { user: racer.id }),
        api('GET', '/wishlist', { user: racer.id }),
      ]);

      expect(results.map((result) => result.status)).toEqual([
        HttpStatus.OK,
        HttpStatus.OK,
        HttpStatus.OK,
      ]);
      expect(new Set(results.map((result) => result.body.id)).size).toBe(1);
      expect(await prisma.wishlist.count({ where: { userId: racer.id } })).toBe(
        1,
      );
    });
  });

  describe('removing one item', () => {
    it('deletes the entry and leaves the rest', async () => {
      await api('DELETE', '/wishlist', { user: otherUserId });
      await api('POST', '/wishlist/items', {
        user: otherUserId,
        body: { productId },
      });
      await api('POST', '/wishlist/items', {
        user: otherUserId,
        body: { productId: otherProductId },
      });

      const wishlist = await getWishlist(otherUserId);
      const target = wishlist.items.find(
        (item: { productId: string }) => item.productId === productId,
      );

      const res = await api('DELETE', `/wishlist/items/${target.id}`, {
        user: otherUserId,
      });

      expect(res.status).toBe(HttpStatus.NO_CONTENT);
      expect(res.body).toBeUndefined();

      const after = await getWishlist(otherUserId);
      expect(after.items).toHaveLength(1);
      expect(after.items[0].productId).toBe(otherProductId);
      expect(after.itemCount).toBe(1);
    });

    it("refuses to touch another user's entry and leaves it in place", async () => {
      const theirs = await getWishlist(otherUserId);
      const target = theirs.items[0];

      const res = await api('DELETE', `/wishlist/items/${target.id}`, {
        user: userId,
      });

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
      expect((await getWishlist(otherUserId)).items).toHaveLength(1);
    });

    it('answers 404 for a well-formed id that does not exist', async () => {
      const res = await api('DELETE', `/wishlist/items/${randomUUID()}`, {
        user: otherUserId,
      });

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
    });

    it('answers 400 for a malformed id, before any lookup', async () => {
      const res = await api('DELETE', '/wishlist/items/not-a-uuid', {
        user: otherUserId,
      });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('answers 404 when the caller has no wishlist yet', async () => {
      const newcomer = await prisma.user.create({
        data: {
          firstName: 'Wish',
          lastName: 'Newcomer',
          email: email('newcomer'),
          passwordHash: 'argon2-not-a-real-hash',
          status: 'ACTIVE',
        },
      });

      const res = await api('DELETE', `/wishlist/items/${randomUUID()}`, {
        user: newcomer.id,
      });

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
      expect(
        await prisma.wishlist.count({ where: { userId: newcomer.id } }),
      ).toBe(0);
    });
  });

  describe('clearing the wishlist', () => {
    it('empties it but keeps the row and its id', async () => {
      await api('POST', '/wishlist/items', { body: { productId } });
      const before = await getWishlist(userId);
      expect(before.items.length).toBeGreaterThan(0);

      const res = await api('DELETE', '/wishlist');

      expect(res.status).toBe(HttpStatus.NO_CONTENT);
      expect(res.body).toBeUndefined();

      const after = await getWishlist(userId);
      expect(after.id).toBe(before.id);
      expect(after.items).toEqual([]);
      expect(after.itemCount).toBe(0);
    });

    it('is a 204 again when repeated, and when already empty', async () => {
      expect((await api('DELETE', '/wishlist')).status).toBe(
        HttpStatus.NO_CONTENT,
      );
      expect((await api('DELETE', '/wishlist')).status).toBe(
        HttpStatus.NO_CONTENT,
      );
    });

    it('is a 204 for a user who never had a wishlist, and creates nothing', async () => {
      const newcomer = await prisma.user.create({
        data: {
          firstName: 'Wish',
          lastName: 'Cleaner',
          email: email('cleaner'),
          passwordHash: 'argon2-not-a-real-hash',
          status: 'ACTIVE',
        },
      });

      const res = await api('DELETE', '/wishlist', { user: newcomer.id });

      expect(res.status).toBe(HttpStatus.NO_CONTENT);
      expect(
        await prisma.wishlist.count({ where: { userId: newcomer.id } }),
      ).toBe(0);
    });
  });

  describe('database constraints are the final protection', () => {
    it('rejects a duplicate (wishlist_id, product_id) row outright', async () => {
      const wishlist = await prisma.wishlist.findUniqueOrThrow({
        where: { userId },
      });
      await prisma.wishlistItem.create({
        data: { wishlistId: wishlist.id, productId },
      });

      await expect(
        prisma.wishlistItem.create({
          data: { wishlistId: wishlist.id, productId },
        }),
      ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    });

    it('rejects a second wishlist for the same user', async () => {
      await expect(
        prisma.wishlist.create({ data: { userId } }),
      ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    });

    it('has no quantity or updated_at column to write', async () => {
      const columns = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
        `select column_name from information_schema.columns where table_name = 'wishlist_items'`,
      );
      const names = columns.map((column) => column.column_name);

      expect(names).toContain('created_at');
      expect(names).not.toContain('quantity');
      expect(names).not.toContain('updated_at');
    });
  });

  describe('deletion behaviour', () => {
    it('deleting the user cascades to the wishlist and its entries', async () => {
      const doomed = await prisma.user.create({
        data: {
          firstName: 'Wish',
          lastName: 'Doomed',
          email: email('doomed'),
          passwordHash: 'argon2-not-a-real-hash',
          status: 'ACTIVE',
        },
      });
      await api('POST', '/wishlist/items', {
        user: doomed.id,
        body: { productId },
      });

      await prisma.user.delete({ where: { id: doomed.id } });

      expect(
        await prisma.wishlist.count({ where: { userId: doomed.id } }),
      ).toBe(0);
      expect(await prisma.wishlistItem.count({ where: { productId } })).toBe(1);
      expect(
        await prisma.wishlistItem.count({
          where: { wishlist: { userId: doomed.id } },
        }),
      ).toBe(0);
    });

    it('deleting a wishlist cascades to its entries', async () => {
      const throwaway = await prisma.user.create({
        data: {
          firstName: 'Wish',
          lastName: 'Throwaway',
          email: email('throwaway'),
          passwordHash: 'argon2-not-a-real-hash',
          status: 'ACTIVE',
        },
      });
      await api('POST', '/wishlist/items', {
        user: throwaway.id,
        body: { productId },
      });

      const wishlist = await prisma.wishlist.findUniqueOrThrow({
        where: { userId: throwaway.id },
      });
      await prisma.wishlist.delete({ where: { id: wishlist.id } });

      expect(
        await prisma.wishlistItem.count({ where: { wishlistId: wishlist.id } }),
      ).toBe(0);
    });

    it('refuses to delete a product a wishlist still references', async () => {
      await api('DELETE', '/wishlist');
      await api('POST', '/wishlist/items', { body: { productId } });

      await expect(
        prisma.product.delete({ where: { id: productId } }),
      ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    });

    it('allows the deletion once the wishlist no longer references the product', async () => {
      // Clear every fixture user's wishlist, not just the caller's, so the
      // product really is unreferenced before the delete is attempted.
      const wishlists = await prisma.wishlist.findMany({
        where: { user: { email: { startsWith: `wish-${run}-` } } },
        select: { id: true },
      });
      await prisma.wishlistItem.deleteMany({
        where: { wishlistId: { in: wishlists.map((wishlist) => wishlist.id) } },
      });

      await expect(
        prisma.product.delete({ where: { id: productId } }),
      ).resolves.toMatchObject({ id: productId });

      // Put the shared fixture back so test ordering cannot matter.
      const restored = await prisma.product.create({
        data: {
          categoryId,
          name: 'Wish product main',
          slug: slug('product-main'),
          basePrice: '19.99',
          status: 'ACTIVE',
        },
      });
      for (const [suffix, price, stock] of [
        ['ONE', '19.99', 5],
        ['TWO', '10.00', 2],
      ] as const) {
        const variant = await prisma.productVariant.create({
          data: {
            productId: restored.id,
            sku: slug(`SKU-main-${suffix}`),
            price,
          },
        });
        await prisma.inventory.create({
          data: { variantId: variant.id, quantity: stock },
        });
      }
      await prisma.productImage.create({
        data: {
          productId: restored.id,
          imageUrl: `https://cdn.example.test/${slug('img-main')}.jpg`,
          publicId: slug('public-main'),
          altText: 'main front',
          sortOrder: 0,
          isPrimary: true,
        },
      });
      productId = restored.id;
    });
  });
});
