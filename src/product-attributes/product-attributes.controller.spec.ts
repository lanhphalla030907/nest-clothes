import {
  HttpStatus,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CreateProductAttributeDto } from './dto/create-product-attribute.dto.js';
import { ProductAttributeResponseDto } from './dto/product-attribute-response.dto.js';
import { UpdateProductAttributeDto } from './dto/update-product-attribute.dto.js';
import { ProductAttributesController } from './product-attributes.controller.js';
import { ProductAttributesService } from './product-attributes.service.js';

const PRODUCT_ID = 'a1b2c3d4-e5f6-4f70-8a9b-0c1d2e3f4a5b';
const ATTRIBUTE_ID = 'c3d4e5f6-a7b8-4c2d-8e3f-4a5b6c7d8e9f';

const buildResponse = (
  overrides: Partial<ProductAttributeResponseDto> = {},
): ProductAttributeResponseDto =>
  Object.assign(new ProductAttributeResponseDto(), {
    id: ATTRIBUTE_ID,
    productId: PRODUCT_ID,
    attributeName: 'Material',
    attributeValue: 'Cotton',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

describe('ProductAttributesController', () => {
  let controller: ProductAttributesController;
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
      controllers: [ProductAttributesController],
      providers: [{ provide: ProductAttributesService, useValue: service }],
    }).compile();

    controller =
      module.get<ProductAttributesController>(ProductAttributesController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('delegates creation with the product id from the path', () => {
    const dto = Object.assign(new CreateProductAttributeDto(), {
      attributeName: 'Material',
      attributeValue: 'Cotton',
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
    expect(controller.findOne(PRODUCT_ID, ATTRIBUTE_ID)).toBeDefined();
    expect(service.findOne).toHaveBeenCalledWith(PRODUCT_ID, ATTRIBUTE_ID);
  });

  it('delegates update with both ids and the dto', () => {
    const dto = Object.assign(new UpdateProductAttributeDto(), {
      attributeValue: 'Linen',
    });
    service.update.mockReturnValue(buildResponse({ attributeValue: 'Linen' }));
    expect(controller.update(PRODUCT_ID, ATTRIBUTE_ID, dto)).toBeDefined();
    expect(service.update).toHaveBeenCalledWith(PRODUCT_ID, ATTRIBUTE_ID, dto);
  });

  it('delegates remove with both ids', async () => {
    service.remove.mockResolvedValue(undefined);
    await expect(
      controller.remove(PRODUCT_ID, ATTRIBUTE_ID),
    ).resolves.toBeUndefined();
    expect(service.remove).toHaveBeenCalledWith(PRODUCT_ID, ATTRIBUTE_ID);
  });
});

describe('ProductAttributesController (HTTP)', () => {
  let app: INestApplication;
  let service: {
    create: ReturnType<typeof vi.fn>;
    findAllByProductId: ReturnType<typeof vi.fn>;
    findOne: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
  let base: string;

  beforeEach(async () => {
    service = {
      create: vi.fn(),
      findAllByProductId: vi.fn(),
      findOne: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProductAttributesController],
      providers: [{ provide: ProductAttributesService, useValue: service }],
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
    base = `${await app.getUrl()}/products/${PRODUCT_ID}/attributes`;
  });

  afterEach(async () => {
    await app.close();
  });

  it('POST → 201 and the pipe normalizes both fields', async () => {
    service.create.mockResolvedValue(buildResponse());

    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        attributeName: '  Material  ',
        attributeValue: '  Machine   Wash  ',
      }),
    });

    expect(res.status).toBe(HttpStatus.CREATED);
    const dto = service.create.mock.calls[0][1];
    expect(dto.attributeName).toBe('Material');
    expect(dto.attributeValue).toBe('Machine Wash');
  });

  it('GET list → 200', async () => {
    service.findAllByProductId.mockResolvedValue([]);
    const res = await fetch(base);
    expect(res.status).toBe(HttpStatus.OK);
  });

  it('GET one → 200', async () => {
    service.findOne.mockResolvedValue(buildResponse());
    const res = await fetch(`${base}/${ATTRIBUTE_ID}`);
    expect(res.status).toBe(HttpStatus.OK);
  });

  it('PATCH → 200', async () => {
    service.update.mockResolvedValue(buildResponse());
    const res = await fetch(`${base}/${ATTRIBUTE_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attributeValue: 'Linen' }),
    });
    expect(res.status).toBe(HttpStatus.OK);
  });

  it('DELETE → 204', async () => {
    service.remove.mockResolvedValue(undefined);
    const res = await fetch(`${base}/${ATTRIBUTE_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(HttpStatus.NO_CONTENT);
  });

  it('malformed product id → 400 before the service is called', async () => {
    const res = await fetch(
      `${await app.getUrl()}/products/not-a-uuid/attributes`,
    );
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(service.findAllByProductId).not.toHaveBeenCalled();
  });

  it('malformed attribute id → 400 before the service is called', async () => {
    const res = await fetch(`${base}/not-a-uuid`);
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(service.findOne).not.toHaveBeenCalled();
  });

  it('rejects forbidden identity fields', async () => {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        attributeName: 'Material',
        attributeValue: 'Cotton',
        id: ATTRIBUTE_ID,
        productId: PRODUCT_ID,
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    });
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(service.create).not.toHaveBeenCalled();
  });

  it('rejects an empty body', async () => {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
  });

  it('rejects a whitespace-only attribute name', async () => {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attributeName: '   ', attributeValue: 'Cotton' }),
    });
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
  });

  it('rejects a missing attribute value', async () => {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attributeName: 'Material' }),
    });
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
  });

  it('rejects an over-length attribute name', async () => {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        attributeName: 'X'.repeat(51),
        attributeValue: 'Cotton',
      }),
    });
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
  });

  it('rejects an over-length attribute value', async () => {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        attributeName: 'Material',
        attributeValue: 'X'.repeat(256),
      }),
    });
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
  });
});
