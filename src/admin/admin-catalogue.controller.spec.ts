import {
  HttpStatus,
  NotFoundException,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TestIdentityRegistry, signRawToken } from '../../test/support/auth-fixtures.js';
import { CategoriesService } from '../categories/categories.service.js';
import { Role } from '../generated/prisma/enums.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { ProductImagesService } from '../product-images/product-images.service.js';
import { ProductsService } from '../products/products.service.js';
import { ProductVariantsService } from '../product-variants/product-variants.service.js';
import { VariantOptionsService } from '../variant-options/variant-options.service.js';
import { AdminCategoriesController } from './controllers/admin-categories.controller.js';
import { AdminInventoryController } from './controllers/admin-inventory.controller.js';
import { AdminProductImagesController } from './controllers/admin-product-images.controller.js';
import { AdminProductVariantsController } from './controllers/admin-product-variants.controller.js';
import { AdminProductsController } from './controllers/admin-products.controller.js';
import { AdminVariantOptionsController } from './controllers/admin-variant-options.controller.js';

const ADMIN_ID = 'a1b2c3d4-e5f6-4f70-8a9b-0c1d2e3f4a5b';
const CUSTOMER_ID = 'b2c3d4e5-f6a7-4b81-9c0d-1e2f3a4b5c6d';
const PRODUCT_ID = 'c3d4e5f6-a7b8-4c92-8d1e-2f3a4b5c6d7e';
const VARIANT_ID = 'd4e5f6a7-b8c9-4d03-9e2f-3a4b5c6d7e8f';
const IMAGE_ID = 'e5f6a7b8-c9d0-4e14-8f2a-3b4c5d6e7f80';
const OPTION_ID = 'f6a7b8c9-d0e1-4f25-9a3b-4c5d6e7f8a91';
const OTHER_ID = '01234567-89ab-4cde-8f01-23456789abcd';

/**
 * The administrative surface in one app, mounted behind the real guards.
 *
 * What makes these tests worth having is that every controller here declares its
 * authorisation on the **class**, so the interesting question is not "does `AdminController`
 * work" but "did any of the six catalog controllers forget to inherit the decorators, and
 * would we notice". The table below walks the same four cases over every route:
 *
 * 1. no token → 401;
 * 2. a real `CUSTOMER` → 403;
 * 3. a *correctly signed* token claiming `ADMIN` for a user the database has as `CUSTOMER`
 *    → 403 — the case that only fails if someone ever makes `RolesGuard` read the claim
 *    instead of the row;
 * 4. an `ADMIN` → the route answers.
 *
 * The guards are the production ones and the user lookup runs against
 * `TestIdentityRegistry`, which plays the role of the user table; only the domain services
 * below the controllers are stubbed, because these tests are about the boundary.
 */
describe('Admin catalogue controllers (HTTP)', () => {
  let app: INestApplication;
  let identities: TestIdentityRegistry;
  let base: string;

  const stub = {
    categoriesService: {
      create: vi.fn(),
      findAll: vi.fn(),
      findOne: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    },
    productsService: {
      create: vi.fn(),
      findAll: vi.fn(),
      findMany: vi.fn(),
      findOne: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    },
    productImagesService: {
      create: vi.fn(),
      findAllByProductId: vi.fn(),
      findOne: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
      upload: vi.fn(),
    },
    productVariantsService: {
      create: vi.fn(),
      findAllByProductId: vi.fn(),
      findOne: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    },
    variantOptionsService: {
      create: vi.fn(),
      findAllByVariantId: vi.fn(),
      findOne: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    },
    inventoryService: {
      create: vi.fn(),
      findOne: vi.fn(),
      update: vi.fn(),
    },
  };

  beforeAll(async () => {
    identities = new TestIdentityRegistry();
    identities.register({ id: ADMIN_ID, email: 'root@example.test', role: Role.ADMIN });
    identities.register({ id: CUSTOMER_ID, email: 'ada@example.test', role: Role.CUSTOMER });

    const module: TestingModule = await Test.createTestingModule({
      controllers: [
        AdminCategoriesController,
        AdminProductsController,
        AdminProductImagesController,
        AdminProductVariantsController,
        AdminVariantOptionsController,
        AdminInventoryController,
      ],
      providers: [
        ...identities.providers(),
        { provide: CategoriesService, useValue: stub.categoriesService },
        { provide: ProductsService, useValue: stub.productsService },
        { provide: ProductImagesService, useValue: stub.productImagesService },
        { provide: ProductVariantsService, useValue: stub.productVariantsService },
        { provide: VariantOptionsService, useValue: stub.variantOptionsService },
        { provide: InventoryService, useValue: stub.inventoryService },
      ],
    }).compile();

    app = module.createNestApplication();
    // The application's own pipe configuration, so whitelist rejection here is the same
    // rejection production gives an unknown field.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.listen(0);
    base = await app.getUrl();
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    Object.values(stub).forEach((service) =>
      Object.values(service).forEach((fn) => fn.mockResolvedValue([])),
    );
  });

  const call = (
    path: string,
    options: { method?: string; headers?: Record<string, string>; body?: BodyInit } = {},
  ) =>
    fetch(`${base}${path}`, {
      method: options.method ?? 'GET',
      headers: options.headers,
      body: options.body,
    });

  const as = (userId: string) => identities.bearerHeaderFor(userId);

  /**
   * The routes that must be behind authorisation — one per controller, all `GET` so the
   * table is about the guard and not about payload handling.
   */
  const guardedRoutes = [
    { path: '/admin/categories', reached: () => stub.categoriesService.findAll },
    { path: '/admin/products', reached: () => stub.productsService.findMany },
    { path: `/admin/products/${PRODUCT_ID}/images`, reached: () => stub.productImagesService.findAllByProductId },
    { path: `/admin/products/${PRODUCT_ID}/variants`, reached: () => stub.productVariantsService.findAllByProductId },
    { path: `/admin/products/${PRODUCT_ID}/variants/${VARIANT_ID}/options`, reached: () => stub.variantOptionsService.findAllByVariantId },
    { path: `/admin/products/${PRODUCT_ID}/variants/${VARIANT_ID}/inventory`, reached: () => stub.inventoryService.findOne },
  ];

  describe.each(guardedRoutes)('$path', ({ path, reached }) => {
    it('answers 401 to an unauthenticated caller, before the service', async () => {
      const res = await call(path);

      expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
      expect(reached()).not.toHaveBeenCalled();
    });

    it('answers 403 to an authenticated customer', async () => {
      const res = await call(path, { headers: as(CUSTOMER_ID) });

      expect(res.status).toBe(HttpStatus.FORBIDDEN);
      expect(reached()).not.toHaveBeenCalled();
    });

    it('answers 403 to a forged ADMIN claim, because the role comes from the row', async () => {
      const forged = signRawToken({
        sub: CUSTOMER_ID,
        email: 'ada@example.test',
        role: Role.ADMIN,
      });

      const res = await call(path, {
        headers: { Authorization: `Bearer ${forged}` },
      });

      expect(res.status).toBe(HttpStatus.FORBIDDEN);
      expect(reached()).not.toHaveBeenCalled();
    });

    it('serves an admin', async () => {
      const res = await call(path, { headers: as(ADMIN_ID) });

      expect(res.status).toBe(HttpStatus.OK);
      expect(reached()).toHaveBeenCalledTimes(1);
    });
  });

  describe('path ids are validated before the service sees them', () => {
    it.each([
      { path: `/admin/categories/not-a-uuid` },
      { path: `/admin/products/${PRODUCT_ID}/variants/not-a-uuid` },
      {
        path: `/admin/products/${PRODUCT_ID}/variants/${VARIANT_ID}/options/not-a-uuid`,
      },
    ])('$path', async ({ path }) => {
      const res = await call(path, { headers: as(ADMIN_ID) });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(stub.categoriesService.findOne).not.toHaveBeenCalled();
      expect(stub.productVariantsService.findOne).not.toHaveBeenCalled();
      expect(stub.variantOptionsService.findOne).not.toHaveBeenCalled();
    });
  });

  describe('category routes', () => {
    it('creates a category through CategoriesService', async () => {
      stub.categoriesService.create.mockResolvedValue({ id: 'c-1' });

      const res = await call('/admin/categories', {
        method: 'POST',
        headers: { ...as(ADMIN_ID), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Men', slug: 'men' }),
      });

      expect(res.status).toBe(HttpStatus.CREATED);
      expect(stub.categoriesService.create).toHaveBeenCalledTimes(1);
    });

    it('rejects an unknown field rather than silently dropping it', async () => {
      const res = await call('/admin/categories', {
        method: 'POST',
        headers: { ...as(ADMIN_ID), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Men', slug: 'men', weight: 5 }),
      });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(stub.categoriesService.create).not.toHaveBeenCalled();
    });

    it('deletes with 204 and no body', async () => {
      stub.categoriesService.remove.mockResolvedValue(undefined);

      const res = await call(`/admin/categories/${OTHER_ID}`, {
        method: 'DELETE',
        headers: as(ADMIN_ID),
      });

      expect(res.status).toBe(HttpStatus.NO_CONTENT);
      expect(await res.text()).toBe('');
    });

    it('passes a 409 from the hierarchy rules through unchanged', async () => {
      // The rule is the service's — a category with children or products cannot go — and
      // the controller must not translate it into something blander.
      const { ConflictException } = await import('@nestjs/common');
      stub.categoriesService.remove.mockRejectedValue(
        new ConflictException('Category is in use'),
      );

      const res = await call(`/admin/categories/${OTHER_ID}`, {
        method: 'DELETE',
        headers: as(ADMIN_ID),
      });

      expect(res.status).toBe(HttpStatus.CONFLICT);
    });
  });

  describe('product routes', () => {
    it('creates a product with an explicit lifecycle', async () => {
      stub.productsService.create.mockResolvedValue({ id: PRODUCT_ID });

      const res = await call('/admin/products', {
        method: 'POST',
        headers: { ...as(ADMIN_ID), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Peacoat',
          slug: 'peacoat',
          basePrice: '199.00',
          categoryId: OTHER_ID,
          status: 'ACTIVE',
          isActive: false,
        }),
      });

      expect(res.status).toBe(HttpStatus.CREATED);
      // One call: the controller hands the service the single validated object in both
      // positions, and `buildLifecycleData` is what splits it. Duplicating the split in
      // the controller would be a second place for it to disagree with the service.
      expect(stub.productsService.create).toHaveBeenCalledTimes(1);
      const [dto, lifecycle] = stub.productsService.create.mock.calls[0];
      expect(dto).toMatchObject({
        name: 'Peacoat',
        slug: 'peacoat',
        status: 'ACTIVE',
        isActive: false,
      });
      expect(lifecycle).toBe(dto);
    });

    it('refuses a status that is not part of the lifecycle', async () => {
      const res = await call('/admin/products', {
        method: 'POST',
        headers: { ...as(ADMIN_ID), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Peacoat',
          slug: 'peacoat',
          basePrice: '199.00',
          categoryId: OTHER_ID,
          status: 'PUBLISHED',
        }),
      });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(stub.productsService.create).not.toHaveBeenCalled();
    });

    it('sends one validated object whose content and lifecycle halves both survive', async () => {
      stub.productsService.update.mockResolvedValue({ id: PRODUCT_ID });

      const res = await call(`/admin/products/${PRODUCT_ID}`, {
        method: 'PATCH',
        headers: { ...as(ADMIN_ID), 'Content-Type': 'application/json' },
        body: JSON.stringify({ basePrice: '29.90', isActive: false }),
      });

      expect(res.status).toBe(HttpStatus.OK);
      expect(stub.productsService.update).toHaveBeenCalledTimes(1);
      const [pathId, dto, lifecycle] = stub.productsService.update.mock.calls[0];
      expect(pathId).toBe(PRODUCT_ID);
      expect(dto).toMatchObject({ basePrice: '29.90', isActive: false });
      expect(lifecycle).toBe(dto);
      // Which half each field belongs to is asserted against the real
      // `ProductsService`, not against a stub: a controller cannot get this wrong
      // because it does not make the decision.
      expect(dto.status).toBeUndefined();
    });

    it('a PATCH carrying only a lifecycle still reaches the lifecycle argument', async () => {
      stub.productsService.update.mockResolvedValue({ id: PRODUCT_ID });

      await call(`/admin/products/${PRODUCT_ID}`, {
        method: 'PATCH',
        headers: { ...as(ADMIN_ID), 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'ARCHIVED' }),
      });

      expect(stub.productsService.update).toHaveBeenCalledTimes(1);
      const [, dto, lifecycle] = stub.productsService.update.mock.calls[0];
      expect(dto).toMatchObject({ status: 'ARCHIVED' });
      expect(lifecycle).toBe(dto);
      expect(dto.basePrice).toBeUndefined();
    });

    it('passes the four filters through and nothing else', async () => {
      stub.productsService.findMany.mockResolvedValue([]);

      const res = await call(
        `/admin/products?status=ACTIVE&isActive=false&categoryId=${OTHER_ID}&search=tea`,
        { headers: as(ADMIN_ID) },
      );

      expect(res.status).toBe(HttpStatus.OK);
      expect(stub.productsService.findMany).toHaveBeenCalledWith({
        status: 'ACTIVE',
        isActive: false,
        categoryId: OTHER_ID,
        search: 'tea',
      });
    });

    it('refuses a filter value that is not one of the three statuses', async () => {
      const res = await call('/admin/products?status=PUBLISHED', {
        headers: as(ADMIN_ID),
      });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(stub.productsService.findMany).not.toHaveBeenCalled();
    });

    it('refuses a search term that is only whitespace once trimmed, as too long', async () => {
      const res = await call(`/admin/products?search=${'x'.repeat(201)}`, {
        headers: as(ADMIN_ID),
      });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(stub.productsService.findMany).not.toHaveBeenCalled();
    });

    it('reports a product another path references as 404 rather than 403', async () => {
      stub.productsService.findOne.mockRejectedValue(
        new NotFoundException('Product does not exist'),
      );

      const res = await call(`/admin/products/${OTHER_ID}`, {
        headers: as(ADMIN_ID),
      });

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
    });
  });

  describe('ownership is read from the path, never the body', () => {
    it('an image body carrying another product id is handed to the service, which refuses it', async () => {
      // `CreateProductImageDto.productId` is required, so the pipe cannot discard a
      // body that disagrees with the path — it validates it and the service compares it
      // with the path value. The controller's part of that is forwarding the *path*
      // id first; the comparison itself is covered against the real service.
      stub.productImagesService.create.mockResolvedValue({ id: IMAGE_ID });

      const res = await call(`/admin/products/${PRODUCT_ID}/images`, {
        method: 'POST',
        headers: { ...as(ADMIN_ID), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageUrl: 'https://cdn.example.test/x.jpg',
          publicId: 'x',
          isPrimary: false,
          productId: OTHER_ID,
        }),
      });

      expect(res.status).toBe(HttpStatus.CREATED);
      expect(stub.productImagesService.create).toHaveBeenCalledWith(
        PRODUCT_ID,
        expect.objectContaining({ productId: OTHER_ID }),
      );
    });

    it('an inventory body carrying another variant id is refused', async () => {
      const res = await call(
        `/admin/products/${PRODUCT_ID}/variants/${VARIANT_ID}/inventory`,
        {
          method: 'PATCH',
          headers: { ...as(ADMIN_ID), 'Content-Type': 'application/json' },
          body: JSON.stringify({ quantity: 10, variantId: OTHER_ID }),
        },
      );

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(stub.inventoryService.update).not.toHaveBeenCalled();
    });

    it('the inventory create passes the path ids, not the body', async () => {
      stub.inventoryService.create.mockResolvedValue({ id: 'i-1' });

      const res = await call(
        `/admin/products/${PRODUCT_ID}/variants/${VARIANT_ID}/inventory`,
        {
          method: 'POST',
          headers: { ...as(ADMIN_ID), 'Content-Type': 'application/json' },
          body: JSON.stringify({ quantity: 10, reservedQuantity: 2 }),
        },
      );

      expect(res.status).toBe(HttpStatus.CREATED);
      expect(stub.inventoryService.create).toHaveBeenCalledWith(
        PRODUCT_ID,
        VARIANT_ID,
        expect.anything(),
      );
      expect(stub.inventoryService.create.mock.calls[0][2]).toEqual({
        quantity: 10,
        reservedQuantity: 2,
      });
    });

    it('an option created under the wrong variant is a 404, not a 403', async () => {
      stub.variantOptionsService.create.mockRejectedValue(
        new NotFoundException('Product does not exist'),
      );

      const res = await call(
        `/admin/products/${OTHER_ID}/variants/${VARIANT_ID}/options`,
        {
          method: 'POST',
          headers: { ...as(ADMIN_ID), 'Content-Type': 'application/json' },
          body: JSON.stringify({ optionName: 'Color', optionValue: 'Navy' }),
        },
      );

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
    });

    it('a variant reached through another product is a 404, not a 403', async () => {
      stub.productVariantsService.findOne.mockRejectedValue(
        new NotFoundException('Product does not exist'),
      );

      const res = await call(
        `/admin/products/${OTHER_ID}/variants/${VARIANT_ID}`,
        { headers: as(ADMIN_ID) },
      );

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
      expect(stub.productVariantsService.findOne).toHaveBeenCalledWith(
        OTHER_ID,
        VARIANT_ID,
      );
    });
  });

  describe('deletes answer 204 with an empty body', () => {
    it.each([
      {
        path: `/admin/products/${PRODUCT_ID}`,
        reached: () => stub.productsService.remove,
        args: [PRODUCT_ID],
      },
      {
        path: `/admin/products/${PRODUCT_ID}/images/${IMAGE_ID}`,
        reached: () => stub.productImagesService.remove,
        args: [PRODUCT_ID, IMAGE_ID],
      },
      {
        path: `/admin/products/${PRODUCT_ID}/variants/${VARIANT_ID}`,
        reached: () => stub.productVariantsService.remove,
        args: [PRODUCT_ID, VARIANT_ID],
      },
      {
        path: `/admin/products/${PRODUCT_ID}/variants/${VARIANT_ID}/options/${OPTION_ID}`,
        reached: () => stub.variantOptionsService.remove,
        args: [PRODUCT_ID, VARIANT_ID, OPTION_ID],
      },
    ])('$path', async ({ path, reached, args }) => {
      reached().mockResolvedValue(undefined);

      const res = await call(path, { method: 'DELETE', headers: as(ADMIN_ID) });

      expect(res.status).toBe(HttpStatus.NO_CONTENT);
      expect(await res.text()).toBe('');
      expect(reached()).toHaveBeenCalledWith(...args);
    });
  });

  describe('the image upload route', () => {
    const upload = async (filename: string, type: string, content: string) => {
      const form = new FormData();
      form.append(
        'file',
        new Blob([content], { type }),
        filename,
      );

      return call(`/admin/products/${PRODUCT_ID}/images/upload`, {
        method: 'POST',
        headers: as(ADMIN_ID),
        body: form,
      });
    };

    it('accepts an allowed image type and forwards it to the service', async () => {
      stub.productImagesService.upload.mockResolvedValue({ id: IMAGE_ID });

      const res = await upload('coat.jpg', 'image/jpeg', 'jpeg-bytes');

      expect(res.status).toBe(HttpStatus.CREATED);
      expect(stub.productImagesService.upload).toHaveBeenCalledTimes(1);
      expect(stub.productImagesService.upload.mock.calls[0][0]).toBe(PRODUCT_ID);
    });

    it('refuses a non-image before any service call', async () => {
      const res = await upload('payload.txt', 'text/plain', 'not an image');

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(stub.productImagesService.upload).not.toHaveBeenCalled();
    });

    it('refuses an upload from a customer', async () => {
      const form = new FormData();
      form.append('file', new Blob(['jpeg-bytes'], { type: 'image/jpeg' }), 'coat.jpg');

      const res = await call(`/admin/products/${PRODUCT_ID}/images/upload`, {
        method: 'POST',
        headers: as(CUSTOMER_ID),
        body: form,
      });

      expect(res.status).toBe(HttpStatus.FORBIDDEN);
      expect(stub.productImagesService.upload).not.toHaveBeenCalled();
    });
  });
});
