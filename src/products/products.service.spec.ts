import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CategoriesRepository } from '../categories/repositories/categories.repository.js';
import { Prisma } from '../generated/prisma/client.js';
import { ProductsService } from './products.service.js';
import { CreateProductDto } from './dto/create-product.dto.js';
import { UpdateProductDto } from './dto/update-product.dto.js';
import { ProductsRepository } from './repositories/products.repository.js';

const buildCreateDto = (
  overrides: Partial<CreateProductDto> = {},
): CreateProductDto =>
  Object.assign(new CreateProductDto(), {
    name: '  Oversized   T-Shirt  ',
    slug: '  OVERSIZED-T-SHIRT  ',
    description: 'Premium oversized cotton t-shirt',
    basePrice: '19.99',
    categoryId: 'c-1',
    ...overrides,
  });

const buildUpdateDto = (
  overrides: Partial<UpdateProductDto> = {},
): UpdateProductDto => Object.assign(new UpdateProductDto(), overrides);

const buildCategory = (overrides: Record<string, unknown> = {}) => ({
  id: 'c-1',
  name: 'Men',
  slug: 'men',
  description: null,
  parentId: null,
  isActive: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

const buildProduct = (overrides: Record<string, unknown> = {}) => ({
  id: 'p-1',
  categoryId: 'c-1',
  name: 'Oversized T-Shirt',
  slug: 'oversized-t-shirt',
  description: 'Premium oversized cotton t-shirt',
  basePrice: '19.99',
  status: 'DRAFT',
  isActive: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

const buildUniqueViolation = (code = 'P2002', meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code,
    clientVersion: '7.10.0',
    meta: {
      modelName: 'Product',
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          originalCode: '23505',
          kind: 'UniqueConstraintViolation',
          constraint: { index: 'products_slug_key' },
          table: 'products',
        },
      },
      ...meta,
    },
  });

describe('ProductsService', () => {
  let service: ProductsService;
  let productRepoCreate: ReturnType<typeof vi.fn>;
  let productRepoFindAll: ReturnType<typeof vi.fn>;
  let productRepoFindById: ReturnType<typeof vi.fn>;
  let productRepoFindBySlug: ReturnType<typeof vi.fn>;
  let productRepoUpdate: ReturnType<typeof vi.fn>;
  let productRepoDelete: ReturnType<typeof vi.fn>;
  let categoryRepoFindById: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    productRepoCreate = vi.fn();
    productRepoFindAll = vi.fn();
    productRepoFindById = vi.fn();
    productRepoFindBySlug = vi.fn();
    productRepoUpdate = vi.fn();
    productRepoDelete = vi.fn();
    categoryRepoFindById = vi.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        {
          provide: ProductsRepository,
          useValue: {
            create: productRepoCreate,
            findAll: productRepoFindAll,
            findById: productRepoFindById,
            findBySlug: productRepoFindBySlug,
            update: productRepoUpdate,
            delete: productRepoDelete,
          },
        },
        {
          provide: CategoriesRepository,
          useValue: { findById: categoryRepoFindById },
        },
      ],
    }).compile();

    service = module.get<ProductsService>(ProductsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    beforeEach(() => {
      productRepoFindBySlug.mockResolvedValue(null);
      categoryRepoFindById.mockResolvedValue(buildCategory());
      productRepoCreate.mockImplementation((data: Record<string, unknown>) =>
        Promise.resolve(buildProduct(data)),
      );
    });

    it('creates a valid product', async () => {
      const result = await service.create(buildCreateDto());

      expect(productRepoCreate).toHaveBeenCalledTimes(1);
      const payload = productRepoCreate.mock.calls[0][0];
      expect(payload).toMatchObject({
        categoryId: 'c-1',
        slug: 'oversized-t-shirt',
        status: 'DRAFT',
        isActive: true,
        basePrice: '19.99',
      });
      expect(payload.name).toBe('Oversized T-Shirt');
      expect(result).toMatchObject({
        id: 'p-1',
        name: 'Oversized T-Shirt',
        basePrice: '19.99',
        status: 'DRAFT',
        isActive: true,
      });
    });

    it('normalizes name', async () => {
      await service.create(buildCreateDto({ name: '  X   Y  ' }));
      expect(productRepoCreate.mock.calls[0][0].name).toBe('X Y');
    });

    it('normalizes slug', async () => {
      await service.create(buildCreateDto({ slug: '  TEES-AND-MORE  ' }));
      expect(productRepoCreate.mock.calls[0][0].slug).toBe('tees-and-more');
    });

    it('defaults status = DRAFT', async () => {
      await service.create(buildCreateDto());
      expect(productRepoCreate.mock.calls[0][0].status).toBe('DRAFT');
    });

    it('defaults isActive = true', async () => {
      await service.create(buildCreateDto());
      expect(productRepoCreate.mock.calls[0][0].isActive).toBe(true);
    });

    it('rejects missing category → 404', async () => {
      categoryRepoFindById.mockResolvedValue(null);
      await expect(service.create(buildCreateDto())).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(productRepoCreate).not.toHaveBeenCalled();
    });

    it('rejects inactive category → 409', async () => {
      categoryRepoFindById.mockResolvedValue(buildCategory({ isActive: false, slug: 'men' }));
      await expect(service.create(buildCreateDto())).rejects.toBeInstanceOf(
        ConflictException,
      );
      await expect(service.create(buildCreateDto())).rejects.toThrow(
        'Category men is not active',
      );
      expect(productRepoCreate).not.toHaveBeenCalled();
    });

    it('rejects duplicate slug → 409', async () => {
      productRepoFindBySlug.mockResolvedValue(buildProduct({ id: 'p-2' }));
      await expect(service.create(buildCreateDto())).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('maps Prisma P2002 → 409', async () => {
      productRepoCreate.mockRejectedValue(buildUniqueViolation());
      await expect(service.create(buildCreateDto())).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('unexpected Prisma error propagates', async () => {
      const failure = new Prisma.PrismaClientKnownRequestError('boom', {
        code: 'P2003',
        clientVersion: '7.10.0',
        meta: { modelName: 'Product' },
      });
      productRepoCreate.mockRejectedValue(failure);
      await expect(service.create(buildCreateDto())).rejects.toBe(failure);
    });
  });

  describe('read', () => {
    it('findOne returns existing product', async () => {
      productRepoFindById.mockResolvedValue(buildProduct());
      const res = await service.findOne('p-1');
      expect(res).toBeDefined();
      expect(res.slug).toBe('oversized-t-shirt');
    });

    it('findOne missing → 404', async () => {
      productRepoFindById.mockResolvedValue(null);
      await expect(service.findOne('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('findAll returns list', async () => {
      productRepoFindAll.mockResolvedValue([buildProduct()]);
      const res = await service.findAll();
      expect(res).toHaveLength(1);
    });
  });

  describe('update', () => {
    beforeEach(() => {
      productRepoFindById.mockResolvedValue(buildProduct({ id: 'p-1' }));
      productRepoFindBySlug.mockResolvedValue(null);
      categoryRepoFindById.mockResolvedValue(buildCategory());
      productRepoUpdate.mockImplementation((id: string, data: Record<string, unknown>) =>
        Promise.resolve(buildProduct({ id, ...data })),
      );
    });

    it('updates name', async () => {
      await service.update('p-1', buildUpdateDto({ name: 'Tee' }));
      expect(productRepoUpdate.mock.calls[0][1].name).toBe('Tee');
    });

    it('updates slug', async () => {
      await service.update('p-1', buildUpdateDto({ slug: 'tee' }));
      expect(productRepoUpdate.mock.calls[0][1].slug).toBe('tee');
    });

    it('updates price', async () => {
      await service.update('p-1', buildUpdateDto({ basePrice: '29.90' }));
      expect(productRepoUpdate.mock.calls[0][1].basePrice).toBe('29.90');
    });

    it('updates description', async () => {
      await service.update('p-1', buildUpdateDto({ description: 'Soft' }));
      expect(productRepoUpdate.mock.calls[0][1].description).toBe('Soft');
    });

    it('updates category', async () => {
      categoryRepoFindById.mockResolvedValue(buildCategory({ id: 'c-2' }));
      await service.update('p-1', buildUpdateDto({ categoryId: 'c-2' }));
      expect(productRepoUpdate.mock.calls[0][1].categoryId).toBe('c-2');
    });

    it('missing product → 404', async () => {
      productRepoFindById.mockResolvedValue(null);
      await expect(service.update('missing', buildUpdateDto())).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('missing category → 404', async () => {
      categoryRepoFindById.mockResolvedValue(null);
      await expect(
        service.update('p-1', buildUpdateDto({ categoryId: 'missing' })),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('inactive category → 409', async () => {
      categoryRepoFindById.mockResolvedValue(buildCategory({ isActive: false, slug: 'men' }));
      await expect(
        service.update('p-1', buildUpdateDto({ categoryId: 'c-1' })),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('duplicate slug → 409', async () => {
      productRepoFindBySlug.mockResolvedValue(buildProduct({ id: 'p-2', slug: 'tee' }));
      await expect(
        service.update('p-1', buildUpdateDto({ slug: 'tee' })),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('P2002 → 409', async () => {
      productRepoUpdate.mockRejectedValue(buildUniqueViolation());
      await expect(
        service.update('p-1', buildUpdateDto({ slug: 'tee' })),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('status cannot be changed through UpdateProductDto', async () => {
      const dto = buildUpdateDto({ name: 'New' }) as UpdateProductDto & {
        status?: string;
      };
      dto.status = 'ACTIVE';
      await service.update('p-1', dto);
      const data = productRepoUpdate.mock.calls[0][1];
      expect(data).not.toHaveProperty('status');
    });

    it('isActive cannot be changed through UpdateProductDto', async () => {
      const dto = buildUpdateDto({ name: 'New' }) as UpdateProductDto & {
        isActive?: boolean;
      };
      dto.isActive = false;
      await service.update('p-1', dto);
      const data = productRepoUpdate.mock.calls[0][1];
      expect(data).not.toHaveProperty('isActive');
    });
  });

  describe('delete', () => {
    it('deletes existing product', async () => {
      productRepoFindById.mockResolvedValue(buildProduct());
      productRepoDelete.mockResolvedValue(buildProduct());
      await expect(service.remove('p-1')).resolves.toBeUndefined();
      expect(productRepoDelete).toHaveBeenCalledWith('p-1');
    });

    it('missing product → 404', async () => {
      productRepoFindById.mockResolvedValue(null);
      await expect(service.remove('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(productRepoDelete).not.toHaveBeenCalled();
    });
  });
});