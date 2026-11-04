import {
  HttpStatus,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { InventoryResponseDto } from './dto/inventory-response.dto.js';
import { InventoryController } from './inventory.controller.js';
import { InventoryService } from './inventory.service.js';

const PRODUCT_ID = 'a1b2c3d4-e5f6-4f70-8a9b-0c1d2e3f4a5b';
const VARIANT_ID = 'b2c3d4e5-f6a0-4a1b-9c2d-3e4f5a6b7c8d';

const buildResponse = (
  overrides: Partial<InventoryResponseDto> = {},
): InventoryResponseDto =>
  Object.assign(new InventoryResponseDto(), {
    id: 'i-1',
    variantId: VARIANT_ID,
    quantity: 10,
    reservedQuantity: 2,
    available: 8,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

describe('InventoryController', () => {
  let controller: InventoryController;
  let service: {
    findOne: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    service = {
      findOne: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [InventoryController],
      providers: [{ provide: InventoryService, useValue: service }],
    }).compile();

    controller = module.get<InventoryController>(InventoryController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('delegates the read', () => {
    service.findOne.mockReturnValue(buildResponse());
    expect(controller.findOne(PRODUCT_ID, VARIANT_ID)).toBeDefined();
    expect(service.findOne).toHaveBeenCalledWith(PRODUCT_ID, VARIANT_ID);
  });

});

describe('InventoryController (HTTP)', () => {
  let app: INestApplication;
  let service: {
    findOne: ReturnType<typeof vi.fn>;
  };
  let base: string;

  beforeEach(async () => {
    service = {
      findOne: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [InventoryController],
      providers: [{ provide: InventoryService, useValue: service }],
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
    base = `${await app.getUrl()}/products/${PRODUCT_ID}/variants/${VARIANT_ID}/inventory`;
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET → 200 and the body exposes the exact response fields', async () => {
    service.findOne.mockResolvedValue(buildResponse());

    const res = await fetch(base);
    expect(res.status).toBe(HttpStatus.OK);

    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(
      [
        'available',
        'createdAt',
        'id',
        'quantity',
        'reservedQuantity',
        'updatedAt',
        'variantId',
      ].sort(),
    );
    expect(body.available).toBe(8);
  });

  it('malformed product id → 400 before the service is called', async () => {
    const res = await fetch(
      `${await app.getUrl()}/products/not-a-uuid/variants/${VARIANT_ID}/inventory`,
    );
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(service.findOne).not.toHaveBeenCalled();
  });

  it('malformed variant id → 400 before the service is called', async () => {
    const res = await fetch(
      `${await app.getUrl()}/products/${PRODUCT_ID}/variants/not-a-uuid/inventory`,
    );
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(service.findOne).not.toHaveBeenCalled();
  });

  it('does not expose public mutation routes', async () => {
    const requests: Array<{ method: string; body: unknown }> = [
      { method: 'POST', body: { quantity: 10 } },
      { method: 'PATCH', body: { quantity: 7 } },
    ];

    for (const request of requests) {
      const res = await fetch(base, {
        method: request.method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request.body),
      });
      expect(res.status).toBe(HttpStatus.NOT_FOUND);
    }
  });
});
