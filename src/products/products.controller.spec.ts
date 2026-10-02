import { HttpStatus, type INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ProductsController } from './products.controller.js';
import { ProductsService } from './products.service.js';
import { ProductResponseDto } from './dto/product-response.dto.js';
import { CreateProductDto } from './dto/create-product.dto.js';
import { UpdateProductDto } from './dto/update-product.dto.js';

const PRODUCT_ID = 'a1b2c3d4-e5f6-4f70-8a9b-0c1d2e3f4a5b';
const CATEGORY_ID = '9e8d7c6b-5a4f-4e3d-9c2b-1a0f9e8d7c6b';

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
    findOne: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    service = {
      create: vi.fn(),
      findAll: vi.fn(),
      findOne: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProductsController],
      providers: [{ provide: ProductsService, useValue: service }],
    }).compile();

    controller = module.get<ProductsController>(ProductsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('delegates creation', () => {
    const dto = Object.assign(new CreateProductDto(), {
      name: 'Tee',
      slug: 'tee',
      basePrice: '10.00',
      categoryId: CATEGORY_ID,
    });
    const expected = buildResponse();
    service.create.mockReturnValue(expected);
    expect(controller.create(dto)).toBe(expected);
    expect(service.create).toHaveBeenCalledWith(dto);
  });

  it('GET → 200', () => {
    service.findAll.mockReturnValue([buildResponse()]);
    expect(controller.findAll()).toHaveLength(1);
  });

  it('GET /:id', () => {
    service.findOne.mockReturnValue(buildResponse());
    expect(controller.findOne(PRODUCT_ID)).toBeDefined();
    expect(service.findOne).toHaveBeenCalledWith(PRODUCT_ID);
  });

  it('PATCH → 200', () => {
    const dto = Object.assign(new UpdateProductDto(), { name: 'New' });
    service.update.mockReturnValue(buildResponse({ name: 'New' }));
    expect(controller.update(PRODUCT_ID, dto)).toBeDefined();
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
    findOne: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    service = {
      create: vi.fn(),
      findAll: vi.fn(),
      findOne: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProductsController],
      providers: [{ provide: ProductsService, useValue: service }],
    }).compile();

    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.listen(0);
  });

  afterEach(async () => {
    await app.close();
  });

  it('POST /products 201', async () => {
    service.create.mockResolvedValue(buildResponse());
    const res = await fetch(`${await app.getUrl()}/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Tee',
        slug: 'tee',
        basePrice: '10.00',
        categoryId: CATEGORY_ID,
      }),
    });
    expect(res.status).toBe(HttpStatus.CREATED);
  });

  it('GET /products 200', async () => {
    service.findAll.mockResolvedValue([]);
    const res = await fetch(`${await app.getUrl()}/products`);
    expect(res.status).toBe(HttpStatus.OK);
  });

  it('GET /products/:id malformed UUID 400', async () => {
    const res = await fetch(`${await app.getUrl()}/products/not-a-uuid`);
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(service.findOne).not.toHaveBeenCalled();
  });

  it('PATCH /products/:id 200', async () => {
    service.update.mockResolvedValue(buildResponse());
    const res = await fetch(`${await app.getUrl()}/products/${PRODUCT_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'X' }),
    });
    expect(res.status).toBe(HttpStatus.OK);
  });

  it('DELETE /products/:id 204', async () => {
    service.remove.mockResolvedValue(undefined);
    const res = await fetch(`${await app.getUrl()}/products/${PRODUCT_ID}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(HttpStatus.NO_CONTENT);
  });

  it('forbidden fields rejected', async () => {
    const res = await fetch(`${await app.getUrl()}/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'T',
        slug: 't',
        basePrice: '1.00',
        categoryId: CATEGORY_ID,
        id: PRODUCT_ID,
        status: 'ACTIVE',
        isActive: false,
      }),
    });
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
  });

  it('invalid DTO 400', async () => {
    const res = await fetch(`${await app.getUrl()}/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
  });
});