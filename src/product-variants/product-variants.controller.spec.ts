import { HttpStatus, ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CreateProductVariantDto } from './dto/create-product-variant.dto.js';
import { ProductVariantResponseDto } from './dto/product-variant-response.dto.js';
import { UpdateProductVariantDto } from './dto/update-product-variant.dto.js';
import { ProductVariantsController } from './product-variants.controller.js';
import { ProductVariantsService } from './product-variants.service.js';

const PRODUCT_ID = 'a1b2c3d4-e5f6-4f70-8a9b-0c1d2e3f4a5b';
const VARIANT_ID = 'b2c3d4e5-f6a0-4a1b-9c2d-3e4f5a6b7c8d';

const buildResponse = (
  overrides: Partial<ProductVariantResponseDto> = {},
): ProductVariantResponseDto =>
  Object.assign(new ProductVariantResponseDto(), {
    id: VARIANT_ID,
    productId: PRODUCT_ID,
    sku: 'TSHIRT-BLK-M',
    price: '19.99',
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

describe('ProductVariantsController', () => {
  let controller: ProductVariantsController;
  let service: {
    create: ReturnType<typeof vi.fn>;
    findAllByProductId: ReturnType<typeof vi.fn>;
    findOne: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    service = {
      create: vi.fn(),
      findAllByProductId: vi.fn(),
      findOne: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProductVariantsController],
      providers: [{ provide: ProductVariantsService, useValue: service }],
    }).compile();

    controller = module.get<ProductVariantsController>(ProductVariantsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('delegates creation with the path product id', () => {
    const dto = Object.assign(new CreateProductVariantDto(), {
      sku: 'AB-1',
      price: '10.00',
    });
    const expected = buildResponse();
    service.create.mockReturnValue(expected);

    expect(controller.create(PRODUCT_ID, dto)).toBe(expected);
    expect(service.create).toHaveBeenCalledWith(PRODUCT_ID, dto);
  });

  it('delegates the listing', () => {
    service.findAllByProductId.mockReturnValue([buildResponse()]);
    expect(controller.findAll(PRODUCT_ID)).toHaveLength(1);
    expect(service.findAllByProductId).toHaveBeenCalledWith(PRODUCT_ID);
  });

  it('delegates findOne with both ids', () => {
    service.findOne.mockReturnValue(buildResponse());
    expect(controller.findOne(PRODUCT_ID, VARIANT_ID)).toBeDefined();
    expect(service.findOne).toHaveBeenCalledWith(PRODUCT_ID, VARIANT_ID);
  });

  it('delegates update with both ids and the dto', () => {
    const dto = Object.assign(new UpdateProductVariantDto(), { price: '12.00' });
    service.update.mockReturnValue(buildResponse({ price: '12.00' }));
    expect(controller.update(PRODUCT_ID, VARIANT_ID, dto)).toBeDefined();
    expect(service.update).toHaveBeenCalledWith(PRODUCT_ID, VARIANT_ID, dto);
  });

  it('delegates remove with both ids', async () => {
    service.remove.mockResolvedValue(undefined);
    await expect(
      controller.remove(PRODUCT_ID, VARIANT_ID),
    ).resolves.toBeUndefined();
    expect(service.remove).toHaveBeenCalledWith(PRODUCT_ID, VARIANT_ID);
  });
});

describe('ProductVariantsController (HTTP)', () => {
  let app: INestApplication;
  let service: {
    create: ReturnType<typeof vi.fn>;
    findAllByProductId: ReturnType<typeof vi.fn>;
    findOne: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    service = {
      create: vi.fn(),
      findAllByProductId: vi.fn(),
      findOne: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProductVariantsController],
      providers: [{ provide: ProductVariantsService, useValue: service }],
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
  });

  afterEach(async () => {
    await app.close();
  });

  it('POST → 201 and the pipe normalizes sku and price', async () => {
    service.create.mockResolvedValue(buildResponse());

    const res = await fetch(
      `${await app.getUrl()}/products/${PRODUCT_ID}/variants`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sku: '  ab-1  ', price: '5.5' }),
      },
    );

    expect(res.status).toBe(HttpStatus.CREATED);
    const dto = service.create.mock.calls[0][1];
    expect(dto.sku).toBe('AB-1');
    expect(dto.price).toBe('5.50');
  });

  it('GET list → 200', async () => {
    service.findAllByProductId.mockResolvedValue([]);
    const res = await fetch(
      `${await app.getUrl()}/products/${PRODUCT_ID}/variants`,
    );
    expect(res.status).toBe(HttpStatus.OK);
  });

  it('GET one → 200', async () => {
    service.findOne.mockResolvedValue(buildResponse());
    const res = await fetch(
      `${await app.getUrl()}/products/${PRODUCT_ID}/variants/${VARIANT_ID}`,
    );
    expect(res.status).toBe(HttpStatus.OK);
  });

  it('PATCH → 200', async () => {
    service.update.mockResolvedValue(buildResponse());
    const res = await fetch(
      `${await app.getUrl()}/products/${PRODUCT_ID}/variants/${VARIANT_ID}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ price: '12.00' }),
      },
    );
    expect(res.status).toBe(HttpStatus.OK);
  });

  it('DELETE → 204', async () => {
    service.remove.mockResolvedValue(undefined);
    const res = await fetch(
      `${await app.getUrl()}/products/${PRODUCT_ID}/variants/${VARIANT_ID}`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(HttpStatus.NO_CONTENT);
  });

  it('malformed product id → 400 before the service is called', async () => {
    const res = await fetch(`${await app.getUrl()}/products/not-a-uuid/variants`);
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(service.findAllByProductId).not.toHaveBeenCalled();
  });

  it('malformed variant id → 400 before the service is called', async () => {
    const res = await fetch(
      `${await app.getUrl()}/products/${PRODUCT_ID}/variants/not-a-uuid`,
    );
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(service.findOne).not.toHaveBeenCalled();
  });

  it('rejects forbidden identity fields', async () => {
    const res = await fetch(
      `${await app.getUrl()}/products/${PRODUCT_ID}/variants`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sku: 'AB-1',
          price: '10.00',
          id: VARIANT_ID,
          productId: PRODUCT_ID,
          createdAt: '2026-01-01T00:00:00.000Z',
        }),
      },
    );
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(service.create).not.toHaveBeenCalled();
  });

  it('rejects a zero price', async () => {
    const res = await fetch(
      `${await app.getUrl()}/products/${PRODUCT_ID}/variants`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sku: 'AB-1', price: '0.00' }),
      },
    );
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
  });

  it('rejects a negative or non-numeric price', async () => {
    for (const price of ['-1.00', 'abc', '1.999']) {
      const res = await fetch(
        `${await app.getUrl()}/products/${PRODUCT_ID}/variants`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sku: 'AB-1', price }),
        },
      );
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    }
  });

  it('rejects an empty body', async () => {
    const res = await fetch(
      `${await app.getUrl()}/products/${PRODUCT_ID}/variants`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
  });
});
