import { HttpStatus, ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CreateVariantOptionDto } from './dto/create-variant-option.dto.js';
import { UpdateVariantOptionDto } from './dto/update-variant-option.dto.js';
import { VariantOptionResponseDto } from './dto/variant-option-response.dto.js';
import { VariantOptionsController } from './variant-options.controller.js';
import { VariantOptionsService } from './variant-options.service.js';

const PRODUCT_ID = 'a1b2c3d4-e5f6-4f70-8a9b-0c1d2e3f4a5b';
const VARIANT_ID = 'b2c3d4e5-f6a0-4a1b-9c2d-3e4f5a6b7c8d';
const OPTION_ID = 'c3d4e5f6-a7b8-4c2d-8e3f-4a5b6c7d8e9f';

const buildResponse = (
  overrides: Partial<VariantOptionResponseDto> = {},
): VariantOptionResponseDto =>
  Object.assign(new VariantOptionResponseDto(), {
    id: OPTION_ID,
    variantId: VARIANT_ID,
    optionName: 'Color',
    optionValue: 'Black',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

describe('VariantOptionsController', () => {
  let controller: VariantOptionsController;
  let service: {
    create: ReturnType<typeof vi.fn>;
    findAllByVariantId: ReturnType<typeof vi.fn>;
    findOne: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    service = {
      create: vi.fn(),
      findAllByVariantId: vi.fn(),
      findOne: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [VariantOptionsController],
      providers: [{ provide: VariantOptionsService, useValue: service }],
    }).compile();

    controller = module.get<VariantOptionsController>(VariantOptionsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('delegates creation with both path ids', () => {
    const dto = Object.assign(new CreateVariantOptionDto(), {
      optionName: 'Color',
      optionValue: 'Black',
    });
    const expected = buildResponse();
    service.create.mockReturnValue(expected);

    expect(controller.create(PRODUCT_ID, VARIANT_ID, dto)).toBe(expected);
    expect(service.create).toHaveBeenCalledWith(PRODUCT_ID, VARIANT_ID, dto);
  });

  it('delegates the listing', () => {
    service.findAllByVariantId.mockReturnValue([buildResponse()]);
    expect(controller.findAll(PRODUCT_ID, VARIANT_ID)).toHaveLength(1);
    expect(service.findAllByVariantId).toHaveBeenCalledWith(
      PRODUCT_ID,
      VARIANT_ID,
    );
  });

  it('delegates findOne with all three ids', () => {
    service.findOne.mockReturnValue(buildResponse());
    expect(controller.findOne(PRODUCT_ID, VARIANT_ID, OPTION_ID)).toBeDefined();
    expect(service.findOne).toHaveBeenCalledWith(
      PRODUCT_ID,
      VARIANT_ID,
      OPTION_ID,
    );
  });

  it('delegates update with all three ids and the dto', () => {
    const dto = Object.assign(new UpdateVariantOptionDto(), {
      optionValue: 'White',
    });
    service.update.mockReturnValue(buildResponse({ optionValue: 'White' }));
    expect(controller.update(PRODUCT_ID, VARIANT_ID, OPTION_ID, dto)).toBeDefined();
    expect(service.update).toHaveBeenCalledWith(
      PRODUCT_ID,
      VARIANT_ID,
      OPTION_ID,
      dto,
    );
  });

  it('delegates remove with all three ids', async () => {
    service.remove.mockResolvedValue(undefined);
    await expect(
      controller.remove(PRODUCT_ID, VARIANT_ID, OPTION_ID),
    ).resolves.toBeUndefined();
    expect(service.remove).toHaveBeenCalledWith(
      PRODUCT_ID,
      VARIANT_ID,
      OPTION_ID,
    );
  });
});

describe('VariantOptionsController (HTTP)', () => {
  let app: INestApplication;
  let service: {
    create: ReturnType<typeof vi.fn>;
    findAllByVariantId: ReturnType<typeof vi.fn>;
    findOne: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
  let base: string;

  beforeEach(async () => {
    service = {
      create: vi.fn(),
      findAllByVariantId: vi.fn(),
      findOne: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [VariantOptionsController],
      providers: [{ provide: VariantOptionsService, useValue: service }],
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
    base = `${await app.getUrl()}/products/${PRODUCT_ID}/variants/${VARIANT_ID}/options`;
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
        optionName: '  Color  ',
        optionValue: '  Extra   Large  ',
      }),
    });

    expect(res.status).toBe(HttpStatus.CREATED);
    const dto = service.create.mock.calls[0][2];
    expect(dto.optionName).toBe('Color');
    expect(dto.optionValue).toBe('Extra Large');
  });

  it('GET list → 200', async () => {
    service.findAllByVariantId.mockResolvedValue([]);
    const res = await fetch(base);
    expect(res.status).toBe(HttpStatus.OK);
  });

  it('GET one → 200', async () => {
    service.findOne.mockResolvedValue(buildResponse());
    const res = await fetch(`${base}/${OPTION_ID}`);
    expect(res.status).toBe(HttpStatus.OK);
  });

  it('PATCH → 200', async () => {
    service.update.mockResolvedValue(buildResponse());
    const res = await fetch(`${base}/${OPTION_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ optionValue: 'White' }),
    });
    expect(res.status).toBe(HttpStatus.OK);
  });

  it('DELETE → 204', async () => {
    service.remove.mockResolvedValue(undefined);
    const res = await fetch(`${base}/${OPTION_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(HttpStatus.NO_CONTENT);
  });

  it('malformed product id → 400 before the service is called', async () => {
    const res = await fetch(
      `${await app.getUrl()}/products/not-a-uuid/variants/${VARIANT_ID}/options`,
    );
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(service.findAllByVariantId).not.toHaveBeenCalled();
  });

  it('malformed variant id → 400 before the service is called', async () => {
    const res = await fetch(
      `${await app.getUrl()}/products/${PRODUCT_ID}/variants/not-a-uuid/options`,
    );
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(service.findAllByVariantId).not.toHaveBeenCalled();
  });

  it('malformed option id → 400 before the service is called', async () => {
    const res = await fetch(`${base}/not-a-uuid`);
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(service.findOne).not.toHaveBeenCalled();
  });

  it('rejects forbidden identity fields', async () => {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        optionName: 'Color',
        optionValue: 'Black',
        id: OPTION_ID,
        variantId: VARIANT_ID,
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

  it('rejects a whitespace-only option name', async () => {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ optionName: '   ', optionValue: 'Black' }),
    });
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
  });

  it('rejects a missing option value', async () => {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ optionName: 'Color' }),
    });
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
  });

  it('rejects an over-length option name', async () => {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        optionName: 'X'.repeat(51),
        optionValue: 'Black',
      }),
    });
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
  });

  it('rejects an over-length option value', async () => {
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        optionName: 'Color',
        optionValue: 'X'.repeat(101),
      }),
    });
    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
  });
});
