import { HttpStatus, ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
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
    findAllByVariantId: ReturnType<typeof vi.fn>;
    findOne: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    service = {
      findAllByVariantId: vi.fn(),
      findOne: vi.fn(),
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

});

describe('VariantOptionsController (HTTP)', () => {
  let app: INestApplication;
  let service: {
    findAllByVariantId: ReturnType<typeof vi.fn>;
    findOne: ReturnType<typeof vi.fn>;
  };
  let base: string;

  beforeEach(async () => {
    service = {
      findAllByVariantId: vi.fn(),
      findOne: vi.fn(),
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

  it('does not expose public mutation routes', async () => {
    const requests: Array<{ method: string; path: string; body?: unknown }> = [
      {
        method: 'POST',
        path: base,
        body: { optionName: 'Color', optionValue: 'Black' },
      },
      {
        method: 'PATCH',
        path: `${base}/${OPTION_ID}`,
        body: { optionValue: 'White' },
      },
      { method: 'DELETE', path: `${base}/${OPTION_ID}` },
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
