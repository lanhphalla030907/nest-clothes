import 'dotenv/config';
import {
  HttpStatus,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module.js';
import { bearerHeaders, tokenIssuerFor, type IssueToken } from './support/e2e-auth.js';
import { AccessTokenService } from '../src/auth/jwt/access-token.service.js';
import { Role } from '../src/generated/prisma/enums.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * The administrative catalogue, against a **real PostgreSQL** database.
 *
 * The controller spec next to the controllers proves the authorisation matrix with the
 * domain stubbed out; this file exists for the parts that only a real database can settle,
 * because they are rules the service delegates to a constraint or to a foreign key:
 *
 * - a SKU's uniqueness and the normalisation it is applied to are the same value the
 *   unique index sees;
 * - a duplicate option name is refused *case-insensitively*, which is a
 *   `LOWER(option_name)` index rather than a string comparison in TypeScript;
 * - `reservedQuantity <= quantity` holds under a real `CHECK`;
 * - a `PATCH` that names only `quantity` leaves `reservedQuantity` as the row had it,
 *   which is the transactional merge and cannot be shown with a stub;
 * - a product still on someone's wishlist cannot be deleted, because
 *   `wishlist_items.product_id` is `ON DELETE RESTRICT`, and `P2003` becomes a 409;
 * - an image body naming a product other than the path's is refused by the service.
 *
 * The application under test is the full `AppModule`, so `AdminModule`'s wiring, its
 * imports and its route mappings are exercised rather than re-created here. That also
 * means the fixtures go through the same pipes and guards as any other caller.
 *
 * It runs as part of `npm test` (and `npm run test:e2e`) and needs a reachable
 * `DATABASE_URL` plus the configured `CLOUDINARY_*` values, which `AppModule` reads at
 * construction. Fixtures are namespaced by a per-run token and removed in `afterAll`, so
 * repeated runs never collide and never leave rows behind.
 */
describe('Admin catalogue (PostgreSQL)', () => {
  const run = randomUUID().slice(0, 8);
  const slug = (name: string) => `admin-${run}-${name}`;

  let app: INestApplication;
  let prisma: PrismaService;
  let base: string;
  let adminId: string;
  let customerId: string;
  let issueToken: IssueToken;

  /** Rows this file created, removed in dependency order regardless of how it ended. */
  const createdProductIds: string[] = [];
  const createdCategoryIds: string[] = [];

  /**
   * Sends a request as `user`, by signing that user's access token.
   *
   * The token comes from the application's own `AccessTokenService`, so the guard
   * verifies it exactly as it would a client's, including the database lookup that
   * decides the role. Omitting `user` sends no credential at all.
   */
  const api = async (
    method: string,
    path: string,
    options: { user?: string; body?: unknown; rawHeaders?: Record<string, string> } = {},
  ) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(options.body === undefined
          ? {}
          : { 'Content-Type': 'application/json' }),
        ...(options.user === undefined
          ? {}
          : bearerHeaders(issueToken, false)(options.user)),
        ...options.rawHeaders,
      },
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

  const createCategory = async (name: string) => {
    const res = await api('POST', '/admin/categories', {
      user: adminId,
      body: { name, slug: slug(name) },
    });
    createdCategoryIds.push(res.body.id);

    return res;
  };

  const createProduct = async (overrides: Record<string, unknown> = {}) => {
    const res = await api('POST', '/admin/products', {
      user: adminId,
      body: {
        name: `Admin ${run}`,
        slug: slug(`p-${createdProductIds.length}`),
        basePrice: '49.90',
        categoryId: createdCategoryIds[0],
        ...overrides,
      },
    });
    if (res.body?.id) createdProductIds.push(res.body.id);

    return res;
  };

  const createVariant = async (productId: string, sku: string) =>
    api('POST', `/admin/products/${productId}/variants`, {
      user: adminId,
      body: { sku, price: '39.90' },
    });

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        'DATABASE_URL is not set — the admin integration tests need a real PostgreSQL instance',
      );
    }

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
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
    issueToken = tokenIssuerFor(app);

    adminId = randomUUID();
    customerId = randomUUID();
    await prisma.user.createMany({
      data: [
        {
          id: adminId,
          firstName: 'Admin',
          lastName: run,
          email: `admin-${run}@example.test`,
          passwordHash: 'not-used-here',
          status: 'ACTIVE',
          role: Role.ADMIN,
        },
        {
          id: customerId,
          firstName: 'Customer',
          lastName: run,
          email: `customer-${run}@example.test`,
          passwordHash: 'not-used-here',
          status: 'ACTIVE',
          role: Role.CUSTOMER,
        },
      ],
    });
  }, 120_000);

  afterAll(async () => {
    if (prisma) {
      await prisma.wishlist.deleteMany({ where: { userId: customerId } });
      await prisma.product.deleteMany({
        where: { id: { in: createdProductIds } },
      });
      await prisma.category.deleteMany({
        where: { id: { in: createdCategoryIds } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: [adminId, customerId] } },
      });
    }
    await app?.close();
  });

  describe('authorisation, over the wired application graph', () => {
    it('refuses an unauthenticated caller with 401', async () => {
      const res = await api('GET', '/admin/products');
      expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it('refuses an authenticated customer with 403', async () => {
      const res = await api('GET', '/admin/products', { user: customerId });
      expect(res.status).toBe(HttpStatus.FORBIDDEN);
    });

    it('refuses a token claiming ADMIN for a user the database has as CUSTOMER', async () => {
      // Signed by the application's own token service, so signature, issuer, audience
      // and expiry are all perfectly valid. The role claim is the only thing wrong with
      // it, and it is the thing the database disagrees with.
      const forged = app.get(AccessTokenService).sign({
        id: customerId,
        email: `${customerId}@example.test`,
        role: Role.ADMIN,
      });

      const res = await api('GET', '/admin/products', {
        rawHeaders: { Authorization: `Bearer ${forged}` },
      });

      expect(res.status).toBe(HttpStatus.FORBIDDEN);
    });

    it('serves an admin', async () => {
      const res = await api('GET', '/admin/categories', { user: adminId });
      expect(res.status).toBe(HttpStatus.OK);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe('categories', () => {
    let categoryId: string;

    it('creates a root category', async () => {
      const res = await createCategory('outerwear');
      categoryId = res.body.id;

      expect(res.status).toBe(HttpStatus.CREATED);
      expect(res.body).toMatchObject({
        name: 'outerwear',
        slug: slug('outerwear'),
        parentId: null,
        isActive: true,
      });
    });

    it('refuses a second category with the same slug', async () => {
      const res = await api('POST', '/admin/categories', {
        user: adminId,
        body: { name: 'Outerwear again', slug: slug('outerwear') },
      });

      expect(res.status).toBe(HttpStatus.CONFLICT);
    });

    it('updates it', async () => {
      const res = await api('PATCH', `/admin/categories/${categoryId}`, {
        user: adminId,
        body: { description: `Winter ${run}` },
      });

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.description).toBe(`Winter ${run}`);
      // An omitted `parentId` must not clear an existing one, and an omitted
      // `isActive` must not disable the category.
      expect(res.body.isActive).toBe(true);
    });

    it('refuses to delete a category that still has products', async () => {
      const product = await createProduct({ categoryId });

      const res = await api('DELETE', `/admin/categories/${categoryId}`, {
        user: adminId,
      });

      expect(res.status).toBe(HttpStatus.CONFLICT);
      // The constraint did the refusing; the row is still there.
      expect(
        await prisma.category.findUnique({ where: { id: categoryId } }),
      ).not.toBeNull();
      expect(product.status).toBe(HttpStatus.CREATED);
    });
  });

  describe('products', () => {
    let productId: string;

    it('creates a product with an explicit lifecycle', async () => {
      const res = await createProduct({ status: 'ACTIVE', isActive: false });
      productId = res.body.id;

      expect(res.status).toBe(HttpStatus.CREATED);
      // status and isActive are independent columns and must arrive as given.
      expect(res.body.status).toBe('ACTIVE');
      expect(res.body.isActive).toBe(false);
    });

    it('defaults a product that names no lifecycle to DRAFT', async () => {
      const res = await createProduct();

      expect(res.body.status).toBe('DRAFT');
      expect(res.body.isActive).toBe(true);
    });

    it('refuses a status outside the three lifecycle values', async () => {
      const res = await createProduct({ status: 'PUBLISHED' });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('refuses an unknown field rather than dropping it', async () => {
      const res = await createProduct({ productId: randomUUID() });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('refuses a duplicate slug', async () => {
      const first = await createProduct({ slug: slug('unique') });

      const second = await createProduct({ slug: slug('unique') });

      expect(first.status).toBe(HttpStatus.CREATED);
      expect(second.status).toBe(HttpStatus.CONFLICT);
    });

    it('filters the listing by status', async () => {
      const active = await api('GET', '/admin/products?status=ACTIVE', {
        user: adminId,
      });
      const archived = await api('GET', '/admin/products?status=ARCHIVED', {
        user: adminId,
      });

      expect(active.status).toBe(HttpStatus.OK);
      expect(active.body.some((p: { id: string }) => p.id === productId)).toBe(true);
      expect(archived.body.some((p: { id: string }) => p.id === productId)).toBe(
        false,
      );
    });

    it('refuses a status that is not part of the lifecycle', async () => {
      const res = await api('GET', '/admin/products?status=PUBLISHED', {
        user: adminId,
      });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('answers a price-only PATCH with the price it wrote, lifecycle untouched', async () => {
      // The regression this guards: the handler used to answer with the row read
      // *before* the write, so a client saw the old price and the caller had no way
      // to notice. `status` and `isActive` must also survive an unrelated edit.
      const res = await api('PATCH', `/admin/products/${productId}`, {
        user: adminId,
        body: { basePrice: '59.90' },
      });

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.basePrice).toBe('59.90');
      expect(res.body.status).toBe('ACTIVE');
      expect(res.body.isActive).toBe(false);

      const row = await prisma.product.findUnique({ where: { id: productId } });
      expect(row?.basePrice.toFixed(2)).toBe('59.90');
      expect(row?.status).toBe('ACTIVE');
      expect(row?.isActive).toBe(false);
    });

    it('writes only the lifecycle fields a PATCH names', async () => {
      const res = await api('PATCH', `/admin/products/${productId}`, {
        user: adminId,
        body: { isActive: true },
      });

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.isActive).toBe(true);
      expect(res.body.status).toBe('ACTIVE');
      expect(res.body.basePrice).toBe('59.90');
    });

    it('reports a product another path references as 404', async () => {
      const other = await createProduct({ slug: slug('other-product') });

      const res = await api('GET', `/admin/products/${randomUUID()}`, {
        user: adminId,
      });

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
      expect(other.status).toBe(HttpStatus.CREATED);
    });

    it('deletes a product that nothing references', async () => {
      const doomed = await createProduct({ slug: slug('doomed') });

      const res = await api('DELETE', `/admin/products/${doomed.body.id}`, {
        user: adminId,
      });

      expect(res.status).toBe(HttpStatus.NO_CONTENT);
      expect(
        await prisma.product.findUnique({ where: { id: doomed.body.id } }),
      ).toBeNull();
    });

    it('refuses to delete a product somebody has wishlisted, and leaves it in place', async () => {
      const wished = await createProduct({ slug: slug('wished') });
      const wishlist = await prisma.wishlist.create({
        data: { userId: customerId },
      });
      await prisma.wishlistItem.create({
        data: { wishlistId: wishlist.id, productId: wished.body.id },
      });

      const res = await api('DELETE', `/admin/products/${wished.body.id}`, {
        user: adminId,
      });

      // The only way to know the foreign key really refuses this is to let the
      // database try. The service turns that refusal into a conflict.
      expect(res.status).toBe(HttpStatus.CONFLICT);
      expect(
        await prisma.product.findUnique({ where: { id: wished.body.id } }),
      ).not.toBeNull();

      await prisma.wishlist.delete({ where: { id: wishlist.id } });
    });
  });

  describe('variants', () => {
    let productId: string;
    let otherProductId: string;
    let variantId: string;

    beforeAll(async () => {
      const first = await createProduct({ slug: slug('variant-parent') });
      productId = first.body.id;
      const second = await createProduct({ slug: slug('variant-other') });
      otherProductId = second.body.id;
    });

    it('creates a variant with the SKU normalised', async () => {
      const res = await createVariant(productId, '  admin-run-m ');
      variantId = res.body.id;

      expect(res.status).toBe(HttpStatus.CREATED);
      expect(res.body.sku).toBe('ADMIN-RUN-M');
      expect(res.body.price).toBe('39.90');
    });

    it('refuses a second variant with the same SKU anywhere in the catalogue', async () => {
      const res = await createVariant(otherProductId, 'admin-run-m');

      expect(res.status).toBe(HttpStatus.CONFLICT);
    });

    it('refuses a variant of another product with 404, not 403', async () => {
      const res = await api(
        'GET',
        `/admin/products/${otherProductId}/variants/${variantId}`,
        { user: adminId },
      );

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
    });

    it('updates the price of a variant of this product', async () => {
      const res = await api(
        'PATCH',
        `/admin/products/${productId}/variants/${variantId}`,
        { user: adminId, body: { price: '44.90' } },
      );

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.price).toBe('44.90');
      expect(res.body.sku).toBe('ADMIN-RUN-M');
    });

    it('lists the variants of a product', async () => {
      const res = await api('GET', `/admin/products/${productId}/variants`, {
        user: adminId,
      });

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].id).toBe(variantId);
    });
  });

  describe('variant options', () => {
    let productId: string;
    let variantId: string;

    beforeAll(async () => {
      const product = await createProduct({ slug: slug('option-parent') });
      productId = product.body.id;
      const variant = await createVariant(productId, 'admin-run-option');
      variantId = variant.body.id;
    });

    it('creates an option', async () => {
      const res = await api(
        'POST',
        `/admin/products/${productId}/variants/${variantId}/options`,
        { user: adminId, body: { optionName: '  Color ', optionValue: ' Navy ' } },
      );

      expect(res.status).toBe(HttpStatus.CREATED);
      expect(res.body.optionName).toBe('Color');
      expect(res.body.optionValue).toBe('Navy');
    });

    it('refuses the same option name on the same variant, case-insensitively', async () => {
      const res = await api(
        'POST',
        `/admin/products/${productId}/variants/${variantId}/options`,
        { user: adminId, body: { optionName: 'COLOR', optionValue: 'Black' } },
      );

      // `Color` and `COLOR` are the same name to a case-insensitive unique index,
      // which a plain string comparison in the service would not have caught.
      expect(res.status).toBe(HttpStatus.CONFLICT);
    });

    it('reports an option reached through another product as 404', async () => {
      const res = await api(
        'GET',
        `/admin/products/${randomUUID()}/variants/${variantId}/options`,
        { user: adminId },
      );

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
    });

    it('rejects an option name that is only whitespace', async () => {
      const res = await api(
        'POST',
        `/admin/products/${productId}/variants/${variantId}/options`,
        { user: adminId, body: { optionName: '   ', optionValue: 'x' } },
      );

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });
  });

  describe('inventory', () => {
    let productId: string;
    let variantId: string;
    let otherProductId: string;

    beforeAll(async () => {
      const product = await createProduct({ slug: slug('stock-parent') });
      productId = product.body.id;
      const variant = await createVariant(productId, 'admin-run-stock');
      variantId = variant.body.id;
      const other = await createProduct({ slug: slug('stock-other') });
      otherProductId = other.body.id;
    });

    const inventoryPath = (ownerProduct = productId) =>
      `/admin/products/${ownerProduct}/variants/${variantId}/inventory`;

    it('has no row until one is created', async () => {
      const res = await api('GET', inventoryPath(), { user: adminId });

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
    });

    it('creates one with a starting reservation', async () => {
      const res = await api('POST', inventoryPath(), {
        user: adminId,
        body: { quantity: 5, reservedQuantity: 2 },
      });

      expect(res.status).toBe(HttpStatus.CREATED);
      expect(res.body).toMatchObject({
        quantity: 5,
        reservedQuantity: 2,
        available: 3,
      });
    });

    it('refuses a second row for the same variant', async () => {
      const res = await api('POST', inventoryPath(), {
        user: adminId,
        body: { quantity: 1 },
      });

      expect(res.status).toBe(HttpStatus.CONFLICT);
    });

    it('reports inventory reached through another product as 404', async () => {
      const res = await api('GET', inventoryPath(otherProductId), {
        user: adminId,
      });

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
    });

    it('refuses a reservation larger than the quantity', async () => {
      const res = await api('PATCH', inventoryPath(), {
        user: adminId,
        body: { reservedQuantity: 6 },
      });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      const row = await prisma.inventory.findUnique({ where: { variantId } });
      expect(row?.quantity).toBe(5);
      expect(row?.reservedQuantity).toBe(2);
    });

    it('changes only the counter the PATCH names', async () => {
      const res = await api('PATCH', inventoryPath(), {
        user: adminId,
        body: { quantity: 10 },
      });

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.quantity).toBe(10);
      expect(res.body.reservedQuantity).toBe(2);
      expect(res.body.available).toBe(8);
    });

    it('refuses a body carrying another variant id', async () => {
      const res = await api('PATCH', inventoryPath(), {
        user: adminId,
        body: { quantity: 11, variantId: randomUUID() },
      });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      const row = await prisma.inventory.findUnique({ where: { variantId } });
      expect(row?.quantity).toBe(10);
    });
  });

  describe('image metadata', () => {
    let productId: string;
    let otherProductId: string;
    let imageId: string;

    beforeAll(async () => {
      const product = await createProduct({ slug: slug('image-parent') });
      productId = product.body.id;
      const other = await createProduct({ slug: slug('image-other') });
      otherProductId = other.body.id;
    });

    it('refuses a body whose productId disagrees with the path', async () => {
      const res = await api('POST', `/admin/products/${productId}/images`, {
        user: adminId,
        body: {
          productId: otherProductId,
          imageUrl: 'https://cdn.example.test/coat.jpg',
          publicId: `${run}-coat`,
        },
      });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(await prisma.productImage.count({ where: { productId } })).toBe(0);
    });

    it('records an image when the body matches the path', async () => {
      const res = await api('POST', `/admin/products/${productId}/images`, {
        user: adminId,
        body: {
          productId,
          imageUrl: 'https://cdn.example.test/coat.jpg',
          publicId: `${run}-coat`,
          isPrimary: true,
          altText: 'Navy coat',
        },
      });
      imageId = res.body.id;

      expect(res.status).toBe(HttpStatus.CREATED);
      expect(res.body).toMatchObject({
        productId,
        imageUrl: 'https://cdn.example.test/coat.jpg',
        isPrimary: true,
        altText: 'Navy coat',
      });
    });

    it('lists the images of the product', async () => {
      const res = await api('GET', `/admin/products/${productId}/images`, {
        user: adminId,
      });

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].id).toBe(imageId);
    });

    it('refuses to delete the only primary image, before any remote call', async () => {
      const res = await api(
        'DELETE',
        `/admin/products/${productId}/images/${imageId}`,
        { user: adminId },
      );

      expect(res.status).toBe(HttpStatus.CONFLICT);
      expect(
        await prisma.productImage.findUnique({ where: { id: imageId } }),
      ).not.toBeNull();
    });

    it('reports an image reached through another product as 404', async () => {
      const res = await api(
        'GET',
        `/admin/products/${otherProductId}/images/${imageId}`,
        { user: adminId },
      );

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
    });
  });

  describe('the customer route is still public', () => {
    it('leaves the storefront listing reachable without a token', async () => {
      // Nothing about adding an administrative namespace may change what a shopper
      // can read.
      const res = await fetch(`${base}/products`);
      expect(res.status).toBe(HttpStatus.OK);
    });
  });
});
