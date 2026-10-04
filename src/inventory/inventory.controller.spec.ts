import {
  HttpStatus,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CreateInventoryDto } from './dto/create-inventory.dto.js';
import { InventoryResponseDto } from './dto/inventory-response.dto.js';
import { UpdateInventoryDto } from './dto/update-inventory.dto.js';
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
    create: ReturnType<typeof vi.fn>;
    findOne: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    service = {
      create: vi.fn(),
      findOne: vi.fn(),
      update: vi.fn(),
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

  it('delegates creation with the product and variant ids from the path', () => {
    const dto = Object.assign(new CreateInventoryDto(), { quantity: 10 });
    const expected = buildResponse();
    service.create.mockReturnValue(expected);

    expect(controller.create(PRODUCT_ID, VARIANT_ID, dto)).toBe(expected);
    expect(service.create).toHaveBeenCalledWith(PRODUCT_ID, VARIANT_ID, dto);
  });

  it('delegates the read', () => {
    service.findOne.mockReturnValue(buildResponse());
    expect(controller.findOne(PRODUCT_ID, VARIANT_ID)).toBeDefined();
    expect(service.findOne).toHaveBeenCalledWith(PRODUCT_ID, VARIANT_ID);
  });

  it('delegates the update', () => {
    const dto = Object.assign(new UpdateInventoryDto(), { quantity: 7 });
    service.update.mockReturnValue(buildResponse({ quantity: 7, available: 5 }));
    expect(controller.update(PRODUCT_ID, VARIANT_ID, dto)).toBeDefined();
    expect(service.update).toHaveBeenCalledWith(PRODUCT_ID, VARIANT_ID, dto);
  });
});

describe('InventoryController (HTTP)', () => {
  let app: INestApplication;
  let service: {
    create: ReturnType<typeof vi.fn>;
    findOne: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  let base: string;

  beforeEach(async () => {
    service = {
      create: vi.fn(),
      findOne: vi.fn(),
      update: vi.fn(),
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

  it('POST → 201 and the service receives the counters', async () => {
    service.create.mockResolvedValue(buildResponse());

    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantity: 10, reservedQuantity: 2 }),
    });

    expect(res.status).toBe(HttpStatus.CREATED);
    const dto = service.create.mock.calls[0][2];
    expect(dto.quantity).toBe(10);
    expect(dto.reservedQuantity).toBe(2);
  });

  it('POST with an empty body → 201 so the counters default', async () => {
    service.create.mockResolvedValue(buildResponse());

    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(HttpStatus.CREATED);
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

  it('PATCH → 200', async () => {
    service.update.mockResolvedValue(buildResponse());
    const res = await fetch(base, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantity: 7 }),
    });
    expect(res.status).toBe(HttpStatus.OK);
  });

  it('malformed product id → 400 before the service is called', async () => {
    const res = await fetch(
      `${await app.getUrl()}/products/not-a-uuid/variants/${VARIANT_ID}/inventory`,
    );
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(service.create).not.toHaveBeenCalled();
  });

  it('malformed variant id → 400 before the service is called', async () => {
    const res = await fetch(
      `${await app.getUrl()}/products/${PRODUCT_ID}/variants/not-a-uuid/inventory`,
    );
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(service.findOne).not.toHaveBeenCalled();
  });

  it('rejects forbidden identity fields with 400', async () => {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quantity: 1,
        id: 'i-1',
        variantId: VARIANT_ID,
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    });
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(service.create).not.toHaveBeenCalled();
  });

  it('rejects a fractional quantity with 400', async () => {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantity: 1.5 }),
    });
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
  });

  it('rejects a string quantity with 400', async () => {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantity: '5' }),
    });
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
  });

  it('rejects a negative quantity with 400', async () => {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantity: -1 }),
    });
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
  });

  it('rejects a negative reservedQuantity with 400', async () => {
    const res = await fetch(base, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reservedQuantity: -1 }),
    });
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
  });
});
