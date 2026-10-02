import { HttpStatus, type INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CategoriesController } from './categories.controller.js';
import { CategoriesService } from './categories.service.js';
import { CategoryResponseDto } from './dto/category-response.dto.js';
import { CreateCategoryDto } from './dto/create-category.dto.js';
import { UpdateCategoryDto } from './dto/update-category.dto.js';

const CATEGORY_ID = '3f0a1b2c-4d5e-4f60-8a9b-0c1d2e3f4a5b';
const PARENT_ID = '9e8d7c6b-5a4f-4e3d-9c2b-1a0f9e8d7c6b';

const buildResponse = (
  overrides: Partial<CategoryResponseDto> = {},
): CategoryResponseDto =>
  Object.assign(new CategoryResponseDto(), {
    id: CATEGORY_ID,
    name: 'Clothing',
    slug: 'clothing',
    description: null,
    parentId: null,
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

describe('CategoriesController', () => {
  let controller: CategoriesController;
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
      controllers: [CategoriesController],
      providers: [{ provide: CategoriesService, useValue: service }],
    }).compile();

    controller = module.get<CategoriesController>(CategoriesController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('delegates creation to the service and returns its result', () => {
    const dto = Object.assign(new CreateCategoryDto(), {
      name: 'Clothing',
      slug: 'clothing',
    });
    const expected = buildResponse();
    service.create.mockReturnValue(expected);

    expect(controller.create(dto)).toBe(expected);
    expect(service.create).toHaveBeenCalledTimes(1);
    expect(service.create).toHaveBeenCalledWith(dto);
  });

  it('delegates the listing to the service', () => {
    const expected = [buildResponse()];
    service.findAll.mockReturnValue(expected);

    expect(controller.findAll()).toBe(expected);
    expect(service.findAll).toHaveBeenCalledTimes(1);
  });

  it('delegates a single lookup to the service', () => {
    const expected = buildResponse();
    service.findOne.mockReturnValue(expected);

    expect(controller.findOne(CATEGORY_ID)).toBe(expected);
    expect(service.findOne).toHaveBeenCalledWith(CATEGORY_ID);
  });

  it('delegates an update to the service with the id and the DTO', () => {
    const dto = Object.assign(new UpdateCategoryDto(), { name: 'Men' });
    const expected = buildResponse({ name: 'Men' });
    service.update.mockReturnValue(expected);

    expect(controller.update(CATEGORY_ID, dto)).toBe(expected);
    expect(service.update).toHaveBeenCalledWith(CATEGORY_ID, dto);
  });

  it('delegates a removal to the service and returns nothing', async () => {
    service.remove.mockResolvedValue(undefined);

    await expect(controller.remove(CATEGORY_ID)).resolves.toBeUndefined();
    expect(service.remove).toHaveBeenCalledWith(CATEGORY_ID);
  });

  it('returns the service payload verbatim without enriching it', () => {
    const fromService = buildResponse({ parentId: PARENT_ID });
    service.create.mockReturnValue(fromService);

    const result = controller.create(
      Object.assign(new CreateCategoryDto(), {
        name: 'Men',
        slug: 'men',
      }),
    );

    // Projection into the public shape is the service's job, via
    // `CategoryResponseDto.fromEntity`. The controller must not second-guess it.
    expect(result).toBe(fromService);
  });
});

describe('CategoriesController (HTTP)', () => {
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
      controllers: [CategoriesController],
      providers: [{ provide: CategoriesService, useValue: service }],
    }).compile();

    app = module.createNestApplication();
    // Mirrors the global pipe in `main.ts` so the DTO contract is exercised
    // exactly as it is in production.
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    // `listen(0)` binds an ephemeral port so the suite can exercise real HTTP
    // routing, status codes and the global pipe without a fixed port.
    await app.listen(0);
  });

  afterEach(async () => {
    await app.close();
  });

  it('POST /categories responds 201 with the created category', async () => {
    const created = buildResponse({ name: 'T-Shirts', slug: 't-shirts' });
    service.create.mockResolvedValue(created);

    const response = await globalThis
      .fetch(`${await app.getUrl()}/categories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '  T-Shirts ', slug: 'T-Shirts' }),
      })
      .then(async (res) => ({ status: res.status, body: await res.json() }));

    expect(response.status).toBe(HttpStatus.CREATED);
    expect(response.body).toMatchObject({ slug: 't-shirts' });
    // Exactly the public category fields reach the wire — no storage details.
    expect(Object.keys(response.body).sort()).toEqual([
      'createdAt',
      'description',
      'id',
      'isActive',
      'name',
      'parentId',
      'slug',
      'updatedAt',
    ]);
    expect(service.create).toHaveBeenCalledTimes(1);
  });

  it('POST /categories rejects a malformed slug with 400', async () => {
    const response = await globalThis
      .fetch(`${await app.getUrl()}/categories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'T Shirts', slug: 'not a slug' }),
      })
      .then(async (res) => ({ status: res.status, body: await res.json() }));

    expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    expect(service.create).not.toHaveBeenCalled();
  });

  it('POST /categories rejects an attempt to set id or timestamps with 400', async () => {
    const response = await globalThis
      .fetch(`${await app.getUrl()}/categories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Clothing',
          slug: 'clothing',
          id: CATEGORY_ID,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }),
      })
      .then(async (res) => ({ status: res.status, body: await res.json() }));

    expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    expect(service.create).not.toHaveBeenCalled();
  });

  it('GET /categories responds 200 with the list', async () => {
    service.findAll.mockResolvedValue([buildResponse()]);

    const response = await globalThis
      .fetch(`${await app.getUrl()}/categories`)
      .then(async (res) => ({ status: res.status, body: await res.json() }));

    expect(response.status).toBe(HttpStatus.OK);
    expect(response.body).toHaveLength(1);
    expect(service.findAll).toHaveBeenCalledTimes(1);
  });

  it('GET /categories/:id responds 200 with the category', async () => {
    service.findOne.mockResolvedValue(buildResponse());

    const response = await globalThis
      .fetch(`${await app.getUrl()}/categories/${CATEGORY_ID}`)
      .then(async (res) => ({ status: res.status, body: await res.json() }));

    expect(response.status).toBe(HttpStatus.OK);
    expect(response.body).toMatchObject({ id: CATEGORY_ID });
    expect(service.findOne).toHaveBeenCalledWith(CATEGORY_ID);
  });

  it('GET /categories/:id rejects a non-UUID id with 400 before the service', async () => {
    const response = await globalThis
      .fetch(`${await app.getUrl()}/categories/not-a-uuid`)
      .then(async (res) => ({ status: res.status, body: await res.json() }));

    expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    expect(service.findOne).not.toHaveBeenCalled();
  });

  it('GET /categories/:id surfaces a 404 from the service', async () => {
    const { NotFoundException } = await import('@nestjs/common');
    service.findOne.mockRejectedValue(
      new NotFoundException('Category does not exist'),
    );

    const response = await globalThis
      .fetch(`${await app.getUrl()}/categories/${CATEGORY_ID}`)
      .then(async (res) => ({ status: res.status, body: await res.json() }));

    expect(response.status).toBe(HttpStatus.NOT_FOUND);
  });

  it('PATCH /categories/:id responds 200 with the updated category', async () => {
    service.update.mockResolvedValue(buildResponse({ name: 'Men', slug: 'men' }));

    const response = await globalThis
      .fetch(`${await app.getUrl()}/categories/${CATEGORY_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Men', slug: 'MEN' }),
      })
      .then(async (res) => ({ status: res.status, body: await res.json() }));

    expect(response.status).toBe(HttpStatus.OK);
    expect(response.body).toMatchObject({ slug: 'men' });
    expect(service.update).toHaveBeenCalledTimes(1);
  });

  it('PATCH /categories/:id accepts an explicit null parentId', async () => {
    service.update.mockResolvedValue(buildResponse({ parentId: null }));

    const response = await globalThis
      .fetch(`${await app.getUrl()}/categories/${CATEGORY_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentId: null }),
      })
      .then(async (res) => ({ status: res.status, body: await res.json() }));

    expect(response.status).toBe(HttpStatus.OK);
    expect(service.update.mock.calls[0][1].parentId).toBeNull();
  });

  it('PATCH /categories/:id rejects a non-UUID parentId with 400', async () => {
    const response = await globalThis
      .fetch(`${await app.getUrl()}/categories/${CATEGORY_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentId: PARENT_ID.slice(0, -1) }),
      })
      .then(async (res) => ({ status: res.status, body: await res.json() }));

    expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    expect(service.update).not.toHaveBeenCalled();
  });

  it('DELETE /categories/:id responds 204 with an empty body', async () => {
    service.remove.mockResolvedValue(undefined);

    const response = await globalThis.fetch(
      `${await app.getUrl()}/categories/${CATEGORY_ID}`,
      { method: 'DELETE' },
    );

    expect(response.status).toBe(HttpStatus.NO_CONTENT);
    expect(await response.text()).toBe('');
    expect(service.remove).toHaveBeenCalledWith(CATEGORY_ID);
  });

  it('DELETE /categories/:id surfaces a 409 from the service', async () => {
    const { ConflictException } = await import('@nestjs/common');
    service.remove.mockRejectedValue(
      new ConflictException('Category cannot be deleted while it still has child categories'),
    );

    const response = await globalThis.fetch(
      `${await app.getUrl()}/categories/${CATEGORY_ID}`,
      { method: 'DELETE' },
    );

    expect(response.status).toBe(HttpStatus.CONFLICT);
  });

  it('rejects a malformed JSON body with 400', async () => {
    const response = await globalThis
      .fetch(`${await app.getUrl()}/categories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{ not json',
      })
      .then((res) => res.status);

    expect(response).toBe(HttpStatus.BAD_REQUEST);
    expect(service.create).not.toHaveBeenCalled();
  });
});