import { HttpStatus, ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ProductVariantResponseDto } from './dto/product-variant-response.dto.js';
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
    findAllByProductId: ReturnType<typeof vi.fn>;
    findOne: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    service = {
      findAllByProductId: vi.fn(),
      findOne: vi.fn(),
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

});

describe('ProductVariantsController (HTTP)', () => {
  let app: INestApplication;
  let service: {
    findAllByProductId: ReturnType<typeof vi.fn>;
    findOne: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    service = {
      findAllByProductId: vi.fn(),
      findOne: vi.fn(),
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

  it('does not expose public mutation routes', async () => {
    const base = `${await app.getUrl()}/products/${PRODUCT_ID}/variants`;
    const requests: Array<{ method: string; path: string; body?: unknown }> = [
      { method: 'POST', path: base, body: { sku: 'AB-1', price: '10.00' } },
      {
        method: 'PATCH',
        path: `${base}/${VARIANT_ID}`,
        body: { price: '12.00' },
      },
      { method: 'DELETE', path: `${base}/${VARIANT_ID}` },
    ];

    for (const request of requests) {
      const res = await fetch(request.path, {
        method: request.method,
        ...(request.body === undefined
          ? {}
          : {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(request.body),
            }),
      });
      expect(res.status).toBe(HttpStatus.NOT_FOUND);
    }
  });
});
