import 'dotenv/config';
import {
  HttpStatus,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module.js';
import {
  bearerHeaders,
  tokenIssuerFor,
  type IssueToken,
} from './support/e2e-auth.js';
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
    options: {
      user?: string;
      body?: unknown;
      rawHeaders?: Record<string, string>;
    } = {},
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
      expect(active.body.some((p: { id: string }) => p.id === productId)).toBe(
        true,
      );
      expect(
        archived.body.some((p: { id: string }) => p.id === productId),
      ).toBe(false);
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
    const variantSku = `admin-${run}-m`;

    beforeAll(async () => {
      const first = await createProduct({ slug: slug('variant-parent') });
      productId = first.body.id;
      const second = await createProduct({ slug: slug('variant-other') });
      otherProductId = second.body.id;
    });

    it('creates a variant with the SKU normalised', async () => {
      const res = await createVariant(productId, `  ${variantSku} `);
      variantId = res.body.id;

      expect(res.status).toBe(HttpStatus.CREATED);
      expect(res.body.sku).toBe(variantSku.toUpperCase());
      expect(res.body.price).toBe('39.90');
    });

    it('refuses a second variant with the same SKU anywhere in the catalogue', async () => {
      const res = await createVariant(otherProductId, variantSku);

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
      expect(res.body.sku).toBe(`ADMIN-${run.toUpperCase()}-M`);
    });

    it('lists the variants of a product', async () => {
      const res = await api('GET', `/admin/products/${productId}/variants`, {
        user: adminId,
      });

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].id).toBe(variantId);

      const publicRead = await api('GET', `/products/${productId}/variants`);
      expect(publicRead.status).toBe(HttpStatus.OK);
      expect(publicRead.body[0].id).toBe(variantId);
    });

    it('requires ADMIN for mutations and removes the public write routes', async () => {
      const adminBase = `/admin/products/${productId}/variants`;
      const publicBase = `/products/${productId}/variants`;
      const operations = [
        {
          method: 'POST',
          adminPath: adminBase,
          publicPath: publicBase,
          body: { sku: `BLOCKED-${run}`, price: '10.00' },
        },
        {
          method: 'PATCH',
          adminPath: `${adminBase}/${variantId}`,
          publicPath: `${publicBase}/${variantId}`,
          body: { price: '10.00' },
        },
        {
          method: 'DELETE',
          adminPath: `${adminBase}/${variantId}`,
          publicPath: `${publicBase}/${variantId}`,
        },
      ] as const;

      for (const operation of operations) {
        expect(
          (
            await api(operation.method, operation.adminPath, {
              body: operation.body,
            })
          ).status,
        ).toBe(HttpStatus.UNAUTHORIZED);
        expect(
          (
            await api(operation.method, operation.adminPath, {
              user: customerId,
              body: operation.body,
            })
          ).status,
        ).toBe(HttpStatus.FORBIDDEN);
        expect(
          (
            await api(operation.method, operation.publicPath, {
              body: operation.body,
            })
          ).status,
        ).toBe(HttpStatus.NOT_FOUND);
      }
    });

    it('retires a variant without deleting its inventory', async () => {
      const deleteProduct = await createProduct({
        slug: slug('retire-variant'),
      });
      const created = await createVariant(
        deleteProduct.body.id,
        `admin-${run}-delete`,
      );
      await api(
        'POST',
        `/admin/products/${deleteProduct.body.id}/variants/${created.body.id}/inventory`,
        { user: adminId, body: { quantity: 7, reservedQuantity: 2 } },
      );
      const res = await api(
        'DELETE',
        `/admin/products/${deleteProduct.body.id}/variants/${created.body.id}`,
        { user: adminId },
      );

      expect(created.status).toBe(HttpStatus.CREATED);
      expect(res.status).toBe(HttpStatus.NO_CONTENT);
      expect(
        await prisma.productVariant.findUnique({
          where: { id: created.body.id },
          select: { isActive: true },
        }),
      ).toEqual({ isActive: false });
      expect(
        await prisma.inventory.findUnique({
          where: { variantId: created.body.id },
          select: { quantity: true, reservedQuantity: true },
        }),
      ).toEqual({ quantity: 7, reservedQuantity: 2 });
    });
  });

  describe('variant options', () => {
    let productId: string;
    let variantId: string;

    beforeAll(async () => {
      const product = await createProduct({ slug: slug('option-parent') });
      productId = product.body.id;
      const preview = await api(
        'POST',
        `/admin/products/${productId}/options/preview`,
        {
          user: adminId,
          body: {
            options: [{ name: 'Color', values: [{ value: 'Navy' }] }],
          },
        },
      );
      const saved = await api('PUT', `/admin/products/${productId}/options`, {
        user: adminId,
        body: {
          expectedRevision: preview.body.expectedRevision,
          options: preview.body.options,
          variants: [
            {
              optionValueIds: [preview.body.options[0].values[0].id],
              sku: `ADMIN-${run.toUpperCase()}-OPTION`,
              price: '39.90',
              isActive: true,
            },
          ],
        },
      });
      variantId = saved.body.variants[0].id;
    });

    it('projects normalized options through the existing public read contract', async () => {
      const publicRead = await api(
        'GET',
        `/products/${productId}/variants/${variantId}/options`,
      );
      expect(publicRead.status).toBe(HttpStatus.OK);
      expect(publicRead.body).toHaveLength(1);
      expect(publicRead.body[0]).toMatchObject({
        optionName: 'Color',
        optionValue: 'Navy',
      });
    });

    it('reports an option reached through another product as 404', async () => {
      const res = await api(
        'GET',
        `/admin/products/${randomUUID()}/variants/${variantId}/options`,
        { user: adminId },
      );

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
    });

    it('retires old per-variant option mutations and protects the matrix endpoints', async () => {
      const adminBase = `/admin/products/${productId}/variants/${variantId}/options`;
      const publicBase = `/products/${productId}/variants/${variantId}/options`;
      const legacy = await api('POST', adminBase, {
        user: adminId,
        body: { optionName: 'Size', optionValue: 'M' },
      });
      expect(legacy.status).toBe(HttpStatus.GONE);
      expect((await api('GET', publicBase)).status).toBe(HttpStatus.OK);

      const previewPath = `/admin/products/${productId}/options/preview`;
      const savePath = `/admin/products/${productId}/options`;
      expect(
        (await api('POST', previewPath, { body: { options: [] } })).status,
      ).toBe(HttpStatus.UNAUTHORIZED);
      expect(
        (
          await api('POST', previewPath, {
            user: customerId,
            body: { options: [] },
          })
        ).status,
      ).toBe(HttpStatus.FORBIDDEN);
      expect(
        (
          await api('PUT', savePath, {
            user: customerId,
            body: { expectedRevision: 1, options: [], variants: [] },
          })
        ).status,
      ).toBe(HttpStatus.FORBIDDEN);
      expect(
        (
          await api('POST', previewPath, {
            user: adminId,
            body: { options: [{ name: 'COLOR', values: [{ value: 'Navy' }] }] },
          })
        ).status,
      ).toBe(HttpStatus.OK);
    });
  });

  describe('product option matrix', () => {
    let productId: string;

    beforeAll(async () => {
      const product = await createProduct({ slug: slug('matrix') });
      productId = product.body.id;
    });

    it('generates, saves, extends and retires combinations without losing variant inventory', async () => {
      const options = [
        {
          name: 'Color',
          values: [{ value: 'Black' }, { value: 'White' }, { value: 'Beige' }],
        },
        {
          name: 'Size',
          values: [
            { value: 'S' },
            { value: 'M' },
            { value: 'L' },
            { value: 'XL' },
          ],
        },
      ];
      const preview = await api(
        'POST',
        `/admin/products/${productId}/options/preview`,
        { user: adminId, body: { options } },
      );

      expect(preview.status).toBe(HttpStatus.OK);
      expect(preview.body.variants).toHaveLength(12);

      const sku = (index: number) => `MATRIX-${run.toUpperCase()}-${index}`;
      const savePreview = async (
        generated: typeof preview.body,
        expectedRevision: number,
        startingSku: number,
      ) =>
        api('PUT', `/admin/products/${productId}/options`, {
          user: adminId,
          body: {
            expectedRevision,
            options: generated.options,
            variants: generated.variants.map(
              (variant: Record<string, unknown>, index: number) => ({
                ...(variant.id === undefined ? {} : { id: variant.id }),
                optionValueIds: variant.optionValueIds,
                sku: variant.sku || sku(startingSku + index),
                price: variant.price || '19.90',
                isActive: variant.isActive ?? true,
              }),
            ),
          },
        });

      const duplicateCombination = await api(
        'PUT',
        `/admin/products/${productId}/options`,
        {
          user: adminId,
          body: {
            expectedRevision: preview.body.expectedRevision,
            options: preview.body.options,
            variants: [
              {
                optionValueIds: preview.body.variants[0].optionValueIds,
                sku: sku(90),
                price: '19.90',
                isActive: true,
              },
              {
                optionValueIds: preview.body.variants[0].optionValueIds,
                sku: sku(91),
                price: '19.90',
                isActive: true,
              },
            ],
          },
        },
      );
      expect(duplicateCombination.status).toBe(HttpStatus.BAD_REQUEST);

      const duplicateSku = await api(
        'PUT',
        `/admin/products/${productId}/options`,
        {
          user: adminId,
          body: {
            expectedRevision: preview.body.expectedRevision,
            options: preview.body.options,
            variants: preview.body.variants
              .slice(0, 2)
              .map((variant: Record<string, unknown>) => ({
                optionValueIds: variant.optionValueIds,
                sku: sku(92),
                price: '19.90',
                isActive: true,
              })),
          },
        },
      );
      expect(duplicateSku.status).toBe(HttpStatus.CONFLICT);

      const initial = await savePreview(
        preview.body,
        preview.body.expectedRevision,
        1,
      );
      expect(initial.status).toBe(HttpStatus.OK);
      expect(initial.body.variants).toHaveLength(12);
      expect(
        await prisma.variantOptionValue.count({
          where: { variant: { productId } },
        }),
      ).toBe(24);

      const color = initial.body.options.find(
        (option: { name: string }) => option.name === 'Color',
      );
      const size = initial.body.options.find(
        (option: { name: string }) => option.name === 'Size',
      );
      const blackId = color.values.find(
        (value: { value: string }) => value.value === 'Black',
      ).id;
      const whiteId = color.values.find(
        (value: { value: string }) => value.value === 'White',
      ).id;
      const smallId = size.values.find(
        (value: { value: string }) => value.value === 'S',
      ).id;
      const blackSmall = initial.body.variants.find(
        (variant: { optionValueIds: string[] }) =>
          variant.optionValueIds.includes(blackId) &&
          variant.optionValueIds.includes(smallId),
      );
      const whiteSmall = initial.body.variants.find(
        (variant: { optionValueIds: string[] }) =>
          variant.optionValueIds.includes(whiteId) &&
          variant.optionValueIds.includes(smallId),
      );

      for (const variant of [blackSmall, whiteSmall]) {
        const stock = await api(
          'POST',
          `/admin/products/${productId}/variants/${variant.id}/inventory`,
          { user: adminId, body: { quantity: 6, reservedQuantity: 2 } },
        );
        expect(stock.status).toBe(HttpStatus.CREATED);
      }

      const addedColorOptions = initial.body.options.map(
        (option: {
          id: string;
          name: string;
          values: Array<{ id: string; value: string }>;
        }) => ({
          id: option.id,
          name: option.name,
          values:
            option.name === 'Color'
              ? [
                  ...option.values.map(({ id, value }) => ({ id, value })),
                  { value: 'Olive' },
                ]
              : option.values.map(({ id, value }) => ({ id, value })),
        }),
      );
      const additionPreview = await api(
        'POST',
        `/admin/products/${productId}/options/preview`,
        { user: adminId, body: { options: addedColorOptions } },
      );
      expect(additionPreview.status, JSON.stringify(additionPreview.body)).toBe(
        HttpStatus.OK,
      );
      expect(additionPreview.body.variants).toHaveLength(16);
      expect(
        additionPreview.body.variants.find(
          (variant: { id?: string }) => variant.id === blackSmall.id,
        ),
      ).toBeDefined();

      const extended = await savePreview(
        additionPreview.body,
        initial.body.revision,
        13,
      );
      expect(extended.status).toBe(HttpStatus.OK);
      expect(extended.body.variants).toHaveLength(16);
      expect(
        extended.body.variants.find(
          (variant: { id: string }) => variant.id === blackSmall.id,
        ).inventory,
      ).toMatchObject({ quantity: 6, reservedQuantity: 2, available: 4 });

      const staleSave = await savePreview(
        additionPreview.body,
        initial.body.revision,
        13,
      );
      expect(staleSave.status).toBe(HttpStatus.CONFLICT);

      const removeWhiteOptions = extended.body.options.map(
        (option: {
          id: string;
          name: string;
          values: Array<{ id: string; value: string }>;
        }) => ({
          id: option.id,
          name: option.name,
          values:
            option.name === 'Color'
              ? option.values
                  .filter((value) => value.value !== 'White')
                  .map(({ id, value }) => ({ id, value }))
              : option.values.map(({ id, value }) => ({ id, value })),
        }),
      );
      const retirementPreview = await api(
        'POST',
        `/admin/products/${productId}/options/preview`,
        { user: adminId, body: { options: removeWhiteOptions } },
      );
      expect(retirementPreview.body.variants).toHaveLength(12);
      const retired = await savePreview(
        retirementPreview.body,
        extended.body.revision,
        30,
      );
      expect(retired.status).toBe(HttpStatus.OK);
      expect(
        await prisma.productVariant.findUnique({
          where: { id: whiteSmall.id },
          select: { isActive: true },
        }),
      ).toEqual({ isActive: false });
      expect(
        await prisma.inventory.findUnique({
          where: { variantId: whiteSmall.id },
          select: { quantity: true, reservedQuantity: true },
        }),
      ).toEqual({ quantity: 6, reservedQuantity: 2 });
      expect(
        await prisma.variantOptionValue.count({
          where: { variant: { productId } },
        }),
      ).toBe(32);
    });
  });

  describe('inventory', () => {
    let productId: string;
    let variantId: string;
    let secondVariantId: string;
    let unstockedVariantId: string;
    let otherProductId: string;

    beforeAll(async () => {
      const product = await createProduct({ slug: slug('stock-parent') });
      productId = product.body.id;
      const generated = await api(
        'POST',
        `/admin/products/${productId}/options/preview`,
        {
          user: adminId,
          body: {
            options: [
              {
                name: 'Size',
                values: [{ value: 'S' }, { value: 'M' }, { value: 'L' }],
              },
            ],
          },
        },
      );
      const saved = await api('PUT', `/admin/products/${productId}/options`, {
        user: adminId,
        body: {
          expectedRevision: generated.body.expectedRevision,
          options: generated.body.options,
          variants: generated.body.variants.map(
            (variant: Record<string, unknown>, index: number) => ({
              optionValueIds: variant.optionValueIds,
              sku: `STOCK-${run.toUpperCase()}-${index}`,
              price: '19.90',
              isActive: true,
            }),
          ),
        },
      });
      expect(saved.status).toBe(HttpStatus.OK);
      variantId = saved.body.variants[0].id;
      secondVariantId = saved.body.variants[1].id;
      unstockedVariantId = saved.body.variants[2].id;
      const other = await createProduct({ slug: slug('stock-other') });
      otherProductId = other.body.id;
    });

    const inventoryPath = (ownerProduct = productId) =>
      `/admin/products/${ownerProduct}/variants/${variantId}/inventory`;
    const bulkInventoryPath = () =>
      `/admin/products/${productId}/inventory/bulk`;

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

      const publicRead = await api(
        'GET',
        `/products/${productId}/variants/${variantId}/inventory`,
      );
      expect(publicRead.status).toBe(HttpStatus.OK);
      expect(publicRead.body.available).toBe(3);
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

    it('previews via expected counters and applies set, increase, and decrease without changing reservations', async () => {
      const secondInventory = await api(
        'POST',
        `/admin/products/${productId}/variants/${secondVariantId}/inventory`,
        {
          user: adminId,
          body: { quantity: 7, reservedQuantity: 3 },
        },
      );
      expect(secondInventory.status).toBe(HttpStatus.CREATED);

      const body = (
        operation: 'SET' | 'INCREASE' | 'DECREASE',
        quantity: number,
        expected: Array<{
          variantId: string;
          inventoryExists: boolean;
          quantity: number;
          reservedQuantity: number;
        }>,
      ) => ({
        variantIds: [variantId, secondVariantId],
        operation,
        quantity,
        expectedInventory: expected,
      });
      const initial = [
        { variantId, inventoryExists: true, quantity: 10, reservedQuantity: 2 },
        {
          variantId: secondVariantId,
          inventoryExists: true,
          quantity: 7,
          reservedQuantity: 3,
        },
      ];

      const increased = await api('PATCH', bulkInventoryPath(), {
        user: adminId,
        body: body('INCREASE', 3, initial),
      });
      expect(increased.status).toBe(HttpStatus.OK);
      expect(
        increased.body.map(
          (row: { quantity: number; reservedQuantity: number }) => [
            row.quantity,
            row.reservedQuantity,
          ],
        ),
      ).toEqual([
        [13, 2],
        [10, 3],
      ]);

      const decreased = await api('PATCH', bulkInventoryPath(), {
        user: adminId,
        body: body('DECREASE', 4, [
          {
            variantId,
            inventoryExists: true,
            quantity: 13,
            reservedQuantity: 2,
          },
          {
            variantId: secondVariantId,
            inventoryExists: true,
            quantity: 10,
            reservedQuantity: 3,
          },
        ]),
      });
      expect(decreased.status).toBe(HttpStatus.OK);
      expect(
        decreased.body.map((row: { quantity: number }) => row.quantity),
      ).toEqual([9, 6]);

      const set = await api('PATCH', bulkInventoryPath(), {
        user: adminId,
        body: body('SET', 8, [
          {
            variantId,
            inventoryExists: true,
            quantity: 9,
            reservedQuantity: 2,
          },
          {
            variantId: secondVariantId,
            inventoryExists: true,
            quantity: 6,
            reservedQuantity: 3,
          },
        ]),
      });
      expect(set.status).toBe(HttpStatus.OK);
      expect(
        set.body.map((row: { quantity: number; reservedQuantity: number }) => [
          row.quantity,
          row.reservedQuantity,
        ]),
      ).toEqual([
        [8, 2],
        [8, 3],
      ]);
    });

    it('creates missing stock in mixed batches for set and increase', async () => {
      const set = await api('PATCH', bulkInventoryPath(), {
        user: adminId,
        body: {
          variantIds: [variantId, unstockedVariantId],
          operation: 'SET',
          quantity: 9,
          expectedInventory: [
            {
              variantId,
              inventoryExists: true,
              quantity: 8,
              reservedQuantity: 2,
            },
            {
              variantId: unstockedVariantId,
              inventoryExists: false,
              quantity: 0,
              reservedQuantity: 0,
            },
          ],
        },
      });
      expect(set.status).toBe(HttpStatus.OK);
      expect(
        set.body.map((row: { quantity: number; reservedQuantity: number }) => [
          row.quantity,
          row.reservedQuantity,
        ]),
      ).toEqual([
        [9, 2],
        [9, 0],
      ]);

      await prisma.inventory.delete({
        where: { variantId: unstockedVariantId },
      });
      const increased = await api('PATCH', bulkInventoryPath(), {
        user: adminId,
        body: {
          variantIds: [variantId, unstockedVariantId],
          operation: 'INCREASE',
          quantity: 2,
          expectedInventory: [
            {
              variantId,
              inventoryExists: true,
              quantity: 9,
              reservedQuantity: 2,
            },
            {
              variantId: unstockedVariantId,
              inventoryExists: false,
              quantity: 0,
              reservedQuantity: 0,
            },
          ],
        },
      });
      expect(increased.status).toBe(HttpStatus.OK);
      expect(
        increased.body.map(
          (row: { quantity: number; reservedQuantity: number }) => [
            row.quantity,
            row.reservedQuantity,
          ],
        ),
      ).toEqual([
        [11, 2],
        [2, 0],
      ]);
    });

    it('rejects a mixed decrease that would make new stock negative', async () => {
      await prisma.inventory.delete({
        where: { variantId: unstockedVariantId },
      });
      const decreased = await api('PATCH', bulkInventoryPath(), {
        user: adminId,
        body: {
          variantIds: [variantId, unstockedVariantId],
          operation: 'DECREASE',
          quantity: 1,
          expectedInventory: [
            {
              variantId,
              inventoryExists: true,
              quantity: 11,
              reservedQuantity: 2,
            },
            {
              variantId: unstockedVariantId,
              inventoryExists: false,
              quantity: 0,
              reservedQuantity: 0,
            },
          ],
        },
      });
      expect(decreased.status).toBe(HttpStatus.BAD_REQUEST);
      expect(
        await prisma.inventory.findUnique({ where: { variantId } }),
      ).toMatchObject({ quantity: 11, reservedQuantity: 2 });
      expect(
        await prisma.inventory.findUnique({
          where: { variantId: unstockedVariantId },
        }),
      ).toBeNull();
    });

    it('rejects setting existing reserved stock below its reservation without partial creation', async () => {
      await prisma.inventory.delete({
        where: { variantId: unstockedVariantId },
      });
      const response = await api('PATCH', bulkInventoryPath(), {
        user: adminId,
        body: {
          variantIds: [variantId, unstockedVariantId],
          operation: 'SET',
          quantity: 1,
          expectedInventory: [
            {
              variantId,
              inventoryExists: true,
              quantity: 11,
              reservedQuantity: 2,
            },
            {
              variantId: unstockedVariantId,
              inventoryExists: false,
              quantity: 0,
              reservedQuantity: 0,
            },
          ],
        },
      });
      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
      expect(
        await prisma.inventory.findUnique({ where: { variantId } }),
      ).toMatchObject({ quantity: 11, reservedQuantity: 2 });
      expect(
        await prisma.inventory.findUnique({
          where: { variantId: unstockedVariantId },
        }),
      ).toBeNull();
    });

    it('rejects stale previews without modifying stock', async () => {
      const stale = await api('PATCH', bulkInventoryPath(), {
        user: adminId,
        body: {
          variantIds: [variantId],
          operation: 'INCREASE',
          quantity: 2,
          expectedInventory: [
            {
              variantId,
              inventoryExists: true,
              quantity: 9,
              reservedQuantity: 2,
            },
          ],
        },
      });
      expect(stale.status).toBe(HttpStatus.CONFLICT);
      expect(
        await prisma.inventory.findUnique({ where: { variantId } }),
      ).toMatchObject({ quantity: 11, reservedQuantity: 2 });
    });

    it('requires ADMIN for mutations and removes the public write routes', async () => {
      const adminPath = inventoryPath();
      const publicPath = `/products/${productId}/variants/${variantId}/inventory`;
      const operations = [
        { method: 'POST', body: { quantity: 1 } },
        { method: 'PATCH', body: { quantity: 1 } },
      ] as const;

      for (const operation of operations) {
        expect(
          (
            await api(operation.method, adminPath, {
              body: operation.body,
            })
          ).status,
        ).toBe(HttpStatus.UNAUTHORIZED);
        expect(
          (
            await api(operation.method, adminPath, {
              user: customerId,
              body: operation.body,
            })
          ).status,
        ).toBe(HttpStatus.FORBIDDEN);
        expect(
          (
            await api(operation.method, publicPath, {
              body: operation.body,
            })
          ).status,
        ).toBe(HttpStatus.NOT_FOUND);
      }
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
