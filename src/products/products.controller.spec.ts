import { HttpStatus, ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Role } from '../generated/prisma/enums.js';
import { TestIdentityRegistry } from '../../test/support/auth-fixtures.js';
import { CreateProductDto } from './dto/create-product.dto.js';
import { ProductResponseDto } from './dto/product-response.dto.js';
import { UpdateProductDto } from './dto/update-product.dto.js';
import { ProductsController } from './products.controller.js';
import { ProductsService } from './products.service.js';

const PRODUCT_ID = 'a1b2c3d4-e5f6-4f70-8a9b-0c1d2e3f4a5b';
const CATEGORY_ID = '9e8d7c6b-5a4f-4e3d-9c2b-1a0f9e8d7c6b';
const ADMIN_ID = '11111111-2222-4333-8444-555555555555';
const CUSTOMER_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa';

const buildResponse = (
  overrides: Partial<ProductResponseDto> = {},
): ProductResponseDto =>
  Object.assign(new ProductResponseDto(), {
    id: PRODUCT_ID,
    categoryId: CATEGORY_ID,
    name: 'Oversized T-Shirt',
    slug: 'oversized-t-shirt',
    description: 'Premium oversized cotton t-shirt',
    basePrice: '19.99',
    status: 'DRAFT' as any,
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

describe('ProductsController', () => {
  let controller: ProductsController;
  let service: {
    create: ReturnType<typeof vi.fn>;
    findAll: ReturnType<typeof vi.fn>;
    findPublicProducts: ReturnType<typeof vi.fn>;
    getFilterOptions: ReturnType<typeof vi.fn>;
    findNewArrivals: ReturnType<typeof vi.fn>;
    findBestSellers: ReturnType<typeof vi.fn>;
    findOne: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
  let identities: TestIdentityRegistry;

  beforeEach(async () => {
    identities = new TestIdentityRegistry();
    identities.register({
      id: ADMIN_ID,
      email: 'admin@example.test',
      role: Role.ADMIN,
    });

    service = {
      create: vi.fn(),
      findAll: vi.fn(),
      findPublicProducts: vi.fn(),
      getFilterOptions: vi.fn(),
      findNewArrivals: vi.fn(),
      findBestSellers: vi.fn(),
      findOne: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProductsController],
      providers: [...identities.providers(), { provide: ProductsService, useValue: service }],
    }).compile();

    controller = module.get<ProductsController>(ProductsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('delegates creation', async () => {
    const dto = Object.assign(new CreateProductDto(), {
      name: 'Tee',
      slug: 'tee',
      basePrice: '10.00',
      categoryId: CATEGORY_ID,
    });
    const expected = buildResponse();
    service.create.mockResolvedValue(expected);
    await expect(controller.create(dto)).resolves.toBe(expected);
    expect(service.create).toHaveBeenCalledWith(dto);
  });

  it('GET → 200', async () => {
    service.findPublicProducts.mockResolvedValue({
      data: [buildResponse()],
      total: 1,
      page: 1,
      limit: 12,
      totalPages: 1,
      filterOptions: { categories: [], priceRange: { min: 0, max: 100 }, sizes: [], colors: [] },
    });
    const result = await controller.findAll({} as never);
    expect(result.data).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it('GET /filters → 200', async () => {
    const filterOptions = { categories: [], priceRange: { min: 0, max: 100 }, sizes: [], colors: [] };
    service.getFilterOptions.mockResolvedValue(filterOptions);
    await expect(controller.getFilterOptions()).resolves.toBe(filterOptions);
  });

  it('GET /:id', async () => {
    service.findOne.mockResolvedValue(buildResponse());
    await expect(controller.findOne(PRODUCT_ID)).resolves.toBeDefined();
    expect(service.findOne).toHaveBeenCalledWith(PRODUCT_ID);
  });

  it('PATCH → 200', async () => {
    const dto = Object.assign(new UpdateProductDto(), { name: 'New' });
    service.update.mockResolvedValue(buildResponse({ name: 'New' }));
    await expect(controller.update(PRODUCT_ID, dto)).resolves.toBeDefined();
  });

  it('DELETE → 204', async () => {
    service.remove.mockResolvedValue(undefined);
    await expect(controller.remove(PRODUCT_ID)).resolves.toBeUndefined();
  });
});

describe('ProductsController (HTTP)', () => {
  let app: INestApplication;
  let service: {
    create: ReturnType<typeof vi.fn>;
    findAll: ReturnType<typeof vi.fn>;
    findPublicProducts: ReturnType<typeof vi.fn>;
    getFilterOptions: ReturnType<typeof vi.fn>;
    findNewArrivals: ReturnType<typeof vi.fn>;
    findBestSellers: ReturnType<typeof vi.fn>;
    findOne: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
  let identities: TestIdentityRegistry;
  let base: string;

  const validCreateBody = {
    name: 'Tee',
    slug: 'tee',
    basePrice: '10.00',
    categoryId: CATEGORY_ID,
  };

  beforeAll(async () => {
    identities = new TestIdentityRegistry();
    identities.register({
      id: ADMIN_ID,
      email: 'admin@example.test',
      role: Role.ADMIN,
    });
    identities.register({
      id: CUSTOMER_ID,
      email: 'customer@example.test',
      role: Role.CUSTOMER,
    });

    service = {
      create: vi.fn(),
      findAll: vi.fn(),
      findPublicProducts: vi.fn(),
      getFilterOptions: vi.fn(),
      findNewArrivals: vi.fn(),
      findBestSellers: vi.fn(),
      findOne: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProductsController],
      providers: [...identities.providers(), { provide: ProductsService, useValue: service }],
    }).compile();

    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.listen(0);
    base = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    service.findPublicProducts.mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 12,
      totalPages: 0,
      filterOptions: { categories: [], priceRange: { min: 0, max: 0 }, sizes: [], colors: [] },
    });
    service.getFilterOptions.mockResolvedValue({
      categories: [],
      priceRange: { min: 10, max: 200 },
      sizes: ['S', 'M'],
      colors: ['Black'],
    });
    service.findNewArrivals.mockResolvedValue([]);
    service.findBestSellers.mockResolvedValue([]);
    service.findOne.mockResolvedValue(buildResponse());
    service.create.mockResolvedValue(buildResponse());
    service.update.mockResolvedValue(buildResponse({ name: 'X' }));
    service.remove.mockResolvedValue(undefined);
  });

  const call = (
    path: string,
    options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ) =>
    fetch(`${base}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers ?? {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

  const as = (userId: string) => identities.bearerHeaderFor(userId);

  describe('authorization - mutations', () => {
    it('rejects guest create with 401', async () => {
      const res = await call('/products', { method: 'POST', body: validCreateBody });
      expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
      expect(service.create).not.toHaveBeenCalled();
    });

    it('rejects guest update with 401', async () => {
      const res = await call(`/products/${PRODUCT_ID}`, { method: 'PATCH', body: { name: 'X' } });
      expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
      expect(service.update).not.toHaveBeenCalled();
    });

    it('rejects guest delete with 401', async () => {
      const res = await call(`/products/${PRODUCT_ID}`, { method: 'DELETE' });
      expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
      expect(service.remove).not.toHaveBeenCalled();
    });

    it('rejects CUSTOMER create with 403', async () => {
      const res = await call('/products', {
        method: 'POST',
        body: validCreateBody,
        headers: as(CUSTOMER_ID),
      });
      expect(res.status).toBe(HttpStatus.FORBIDDEN);
      expect(service.create).not.toHaveBeenCalled();
    });

    it('rejects CUSTOMER update with 403', async () => {
      const res = await call(`/products/${PRODUCT_ID}`, {
        method: 'PATCH',
        body: { name: 'X' },
        headers: as(CUSTOMER_ID),
      });
      expect(res.status).toBe(HttpStatus.FORBIDDEN);
      expect(service.update).not.toHaveBeenCalled();
    });

    it('rejects CUSTOMER delete with 403', async () => {
      const res = await call(`/products/${PRODUCT_ID}`, {
        method: 'DELETE',
        headers: as(CUSTOMER_ID),
      });
      expect(res.status).toBe(HttpStatus.FORBIDDEN);
      expect(service.remove).not.toHaveBeenCalled();
    });

    it('allows ADMIN create with 201', async () => {
      const res = await call('/products', {
        method: 'POST',
        body: validCreateBody,
        headers: as(ADMIN_ID),
      });
      expect(res.status).toBe(HttpStatus.CREATED);
      expect(service.create).toHaveBeenCalledTimes(1);
    });

    it('allows ADMIN update with 200', async () => {
      const res = await call(`/products/${PRODUCT_ID}`, {
        method: 'PATCH',
        body: { name: 'X' },
        headers: as(ADMIN_ID),
      });
      expect(res.status).toBe(HttpStatus.OK);
      expect(service.update).toHaveBeenCalledWith(PRODUCT_ID, expect.objectContaining({ name: 'X' }));
    });

    it('allows ADMIN delete with 204', async () => {
      const res = await call(`/products/${PRODUCT_ID}`, {
        method: 'DELETE',
        headers: as(ADMIN_ID),
      });
      expect(res.status).toBe(HttpStatus.NO_CONTENT);
      expect(service.remove).toHaveBeenCalledWith(PRODUCT_ID);
    });
  });

  describe('public read endpoints remain accessible', () => {
    it('GET /products 200 without auth', async () => {
      const res = await call('/products');
      expect(res.status).toBe(HttpStatus.OK);
      expect(service.findPublicProducts).toHaveBeenCalled();
    });

    it('GET /products/new-arrivals 200 without auth', async () => {
      const res = await call('/products/new-arrivals?limit=4');
      expect(res.status).toBe(HttpStatus.OK);
      expect(service.findNewArrivals).toHaveBeenCalledWith(4);
    });

    it('GET /products/best-sellers 200 without auth', async () => {
      const res = await call('/products/best-sellers?limit=6');
      expect(res.status).toBe(HttpStatus.OK);
      expect(service.findBestSellers).toHaveBeenCalledWith(6);
    });

    it('GET /products/filters 200 without auth', async () => {
      const res = await call('/products/filters');
      expect(res.status).toBe(HttpStatus.OK);
      expect(service.getFilterOptions).toHaveBeenCalled();
    });

    it('GET /products/:id 200 without auth', async () => {
      const res = await call(`/products/${PRODUCT_ID}`);
      expect(res.status).toBe(HttpStatus.OK);
      expect(service.findOne).toHaveBeenCalledWith(PRODUCT_ID);
    });

    it('GET /products with invalid minPrice > maxPrice returns 400', async () => {
      const res = await call('/products?minPrice=50&maxPrice=20');
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('GET /products with invalid sortBy returns 400', async () => {
      const res = await call('/products?sortBy=invalid_sort');
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('GET /products/:id malformed UUID 400', async () => {
      const res = await call('/products/not-a-uuid');
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(service.findOne).not.toHaveBeenCalled();
    });
  });

  describe('mutation validation for ADMIN', () => {
    it('rejects forbidden fields on create', async () => {
      const res = await call('/products', {
        method: 'POST',
        headers: as(ADMIN_ID),
        body: {
          ...validCreateBody,
          id: PRODUCT_ID,
          status: 'ACTIVE',
          isActive: false,
        },
      });
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(service.create).not.toHaveBeenCalled();
    });

    it('rejects invalid DTO on create', async () => {
      const res = await call('/products', {
        method: 'POST',
        headers: as(ADMIN_ID),
        body: {},
      });
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(service.create).not.toHaveBeenCalled();
    });
  });
});
