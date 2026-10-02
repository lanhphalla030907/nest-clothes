import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '../generated/prisma/client.js';
import { CategoriesService } from './categories.service.js';
import { CategoryResponseDto } from './dto/category-response.dto.js';
import { CreateCategoryDto } from './dto/create-category.dto.js';
import { UpdateCategoryDto } from './dto/update-category.dto.js';
import { CategoriesRepository } from './repositories/categories.repository.js';

const buildCreateDto = (
  overrides: Partial<CreateCategoryDto> = {},
): CreateCategoryDto =>
  Object.assign(new CreateCategoryDto(), {
    name: 'Clothing',
    slug: 'clothing',
    ...overrides,
  });

const buildUpdateDto = (
  overrides: Partial<UpdateCategoryDto> = {},
): UpdateCategoryDto => Object.assign(new UpdateCategoryDto(), overrides);

const buildEntity = (overrides: Record<string, unknown> = {}) => ({
  id: 'category-1',
  name: 'Clothing',
  slug: 'clothing',
  description: null,
  parentId: null,
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
      modelName: 'Category',
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          originalCode: '23505',
          kind: 'UniqueConstraintViolation',
          constraint: { index: 'categories_slug_key' },
          table: 'categories',
        },
      },
      ...meta,
    },
  });

describe('CategoriesService', () => {
  let service: CategoriesService;
  let repositoryCreate: ReturnType<typeof vi.fn>;
  let repositoryFindAll: ReturnType<typeof vi.fn>;
  let repositoryFindById: ReturnType<typeof vi.fn>;
  let repositoryFindBySlug: ReturnType<typeof vi.fn>;
  let repositoryUpdate: ReturnType<typeof vi.fn>;
  let repositoryDelete: ReturnType<typeof vi.fn>;
  let repositoryCountChildren: ReturnType<typeof vi.fn>;
  let repositoryFindAncestorIds: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    repositoryCreate = vi.fn();
    repositoryFindAll = vi.fn();
    repositoryFindById = vi.fn();
    repositoryFindBySlug = vi.fn();
    repositoryUpdate = vi.fn();
    repositoryDelete = vi.fn();
    repositoryCountChildren = vi.fn();
    repositoryFindAncestorIds = vi.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CategoriesService,
        {
          provide: CategoriesRepository,
          useValue: {
            create: repositoryCreate,
            findAll: repositoryFindAll,
            findById: repositoryFindById,
            findBySlug: repositoryFindBySlug,
            update: repositoryUpdate,
            delete: repositoryDelete,
            countChildren: repositoryCountChildren,
            findAncestorIds: repositoryFindAncestorIds,
          },
        },
      ],
    }).compile();

    service = module.get<CategoriesService>(CategoriesService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    beforeEach(() => {
      repositoryFindBySlug.mockResolvedValue(null);
      repositoryFindById.mockResolvedValue(null);
      repositoryCreate.mockImplementation(
        (data: Record<string, unknown>) =>
          Promise.resolve(buildEntity(data)),
      );
    });

    it('creates a root category when no parentId is supplied', async () => {
      const result = await service.create(buildCreateDto());

      expect(repositoryCreate).toHaveBeenCalledTimes(1);
      expect(repositoryCreate.mock.calls[0][0]).toEqual({
        name: 'Clothing',
        slug: 'clothing',
        description: null,
        parentId: null,
        isActive: true,
      });
      expect(result).toBeInstanceOf(CategoryResponseDto);
      expect(result.parentId).toBeNull();
    });

    it('creates a child category under an existing active parent', async () => {
      repositoryFindById.mockResolvedValue(
        buildEntity({ id: 'parent-1', name: 'Clothing', slug: 'clothing' }),
      );

      await service.create(
        buildCreateDto({ name: 'Men', slug: 'men', parentId: 'parent-1' }),
      );

      expect(repositoryFindById).toHaveBeenCalledWith('parent-1');
      expect(repositoryCreate.mock.calls[0][0].parentId).toBe('parent-1');
    });

    it('normalises the name and slug before persistence', async () => {
      await service.create(
        buildCreateDto({ name: '  T-Shirts   Men ', slug: '  T-SHIRTS-men ' }),
      );

      const persisted = repositoryCreate.mock.calls[0][0];
      expect(persisted.name).toBe('T-Shirts Men');
      expect(persisted.slug).toBe('t-shirts-men');
    });

    it('trims the description and stores an absent one as null', async () => {
      await service.create(
        buildCreateDto({ description: '  Every shirt.  ' }),
      );
      expect(repositoryCreate.mock.calls[0][0].description).toBe(
        'Every shirt.',
      );

      repositoryCreate.mockClear();
      await service.create(buildCreateDto());
      expect(repositoryCreate.mock.calls[0][0].description).toBeNull();
    });

    it('rejects a duplicate slug with 409', async () => {
      repositoryFindBySlug.mockResolvedValue(
        buildEntity({ id: 'other-1', slug: 'clothing' }),
      );

      await expect(service.create(buildCreateDto())).rejects.toBeInstanceOf(
        ConflictException,
      );
      await expect(service.create(buildCreateDto())).rejects.toThrow(
        'A category with this slug already exists',
      );
      expect(repositoryCreate).not.toHaveBeenCalled();
    });

    it('rejects a duplicate slug with 409 when the database reports the race', async () => {
      repositoryCreate.mockRejectedValue(buildUniqueViolation());

      await expect(service.create(buildCreateDto())).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('rejects a nonexistent parent with 404', async () => {
      repositoryFindById.mockResolvedValue(null);

      await expect(
        service.create(buildCreateDto({ parentId: 'missing' })),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repositoryCreate).not.toHaveBeenCalled();
    });

    it('rejects an inactive parent with 409', async () => {
      repositoryFindById.mockResolvedValue(
        buildEntity({ id: 'parent-1', slug: 'archived', isActive: false }),
      );

      await expect(
        service.create(buildCreateDto({ parentId: 'parent-1' })),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        service.create(buildCreateDto({ parentId: 'parent-1' })),
      ).rejects.toThrow('Parent category archived is not active');
      expect(repositoryCreate).not.toHaveBeenCalled();
    });

    it('rethrows unrelated database errors untouched', async () => {
      const failure = new Prisma.PrismaClientKnownRequestError(
        'Foreign key constraint failed',
        { code: 'P2003', clientVersion: '7.10.0', meta: { modelName: 'Category' } },
      );
      repositoryCreate.mockRejectedValue(failure);

      await expect(service.create(buildCreateDto())).rejects.toBe(failure);
    });

    it('rethrows non-Prisma errors untouched', async () => {
      const failure = new Error('connection lost');
      repositoryCreate.mockRejectedValue(failure);

      await expect(service.create(buildCreateDto())).rejects.toBe(failure);
    });
  });

  describe('findAll', () => {
    it('maps every category to the response DTO', async () => {
      repositoryFindAll.mockResolvedValue([
        buildEntity({ id: 'a', name: 'Clothing', slug: 'clothing' }),
        buildEntity({
          id: 'b',
          name: 'Men',
          slug: 'men',
          parentId: 'a',
          isActive: false,
        }),
      ]);

      const result = await service.findAll();

      expect(repositoryFindAll).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(2);
      expect(result[0]).toBeInstanceOf(CategoryResponseDto);
      expect(result[1]).toMatchObject({
        id: 'b',
        parentId: 'a',
        isActive: false,
      });
    });

    it('returns an empty array when there are no categories', async () => {
      repositoryFindAll.mockResolvedValue([]);

      await expect(service.findAll()).resolves.toEqual([]);
    });
  });

  describe('findOne', () => {
    it('returns the mapped category', async () => {
      repositoryFindById.mockResolvedValue(
        buildEntity({ id: 'category-1', name: 'Men', slug: 'men' }),
      );

      const result = await service.findOne('category-1');

      expect(repositoryFindById).toHaveBeenCalledWith('category-1');
      expect(result).toBeInstanceOf(CategoryResponseDto);
      expect(result.slug).toBe('men');
    });

    it('rejects a nonexistent category with 404', async () => {
      repositoryFindById.mockResolvedValue(null);

      await expect(service.findOne('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(service.findOne('missing')).rejects.toThrow(
        'Category missing does not exist',
      );
    });
  });

  describe('update', () => {
    beforeEach(() => {
      repositoryFindById.mockResolvedValue(buildEntity({ id: 'category-1' }));
      repositoryFindBySlug.mockResolvedValue(null);
      repositoryFindAncestorIds.mockResolvedValue([]);
      repositoryUpdate.mockImplementation(
        (id: string, data: Record<string, unknown>) =>
          Promise.resolve(buildEntity({ id, ...data })),
      );
    });

    it('updates the supplied fields and leaves the rest untouched', async () => {
      const result = await service.update(
        'category-1',
        buildUpdateDto({ name: '  Outerwear ', slug: 'OUTERWEAR' }),
      );

      expect(repositoryUpdate).toHaveBeenCalledTimes(1);
      expect(repositoryUpdate).toHaveBeenCalledWith('category-1', {
        name: 'Outerwear',
        slug: 'outerwear',
      });
      expect(result).toBeInstanceOf(CategoryResponseDto);
      expect(result.slug).toBe('outerwear');
    });

    it('rejects a nonexistent category with 404', async () => {
      repositoryFindById.mockResolvedValue(null);

      await expect(
        service.update('missing', buildUpdateDto({ name: 'Men' })),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repositoryUpdate).not.toHaveBeenCalled();
    });

    it('rejects a duplicate slug on update with 409', async () => {
      repositoryFindBySlug.mockResolvedValue(
        buildEntity({ id: 'other-1', slug: 'men' }),
      );

      await expect(
        service.update('category-1', buildUpdateDto({ slug: 'men' })),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repositoryUpdate).not.toHaveBeenCalled();
    });

    it('allows an update to keep its own slug', async () => {
      repositoryFindBySlug.mockResolvedValue(buildEntity({ id: 'category-1' }));

      await service.update('category-1', buildUpdateDto({ slug: 'clothing' }));

      expect(repositoryUpdate).toHaveBeenCalledWith('category-1', {
        slug: 'clothing',
      });
    });

    it('rejects a category becoming its own parent with 400', async () => {
      await expect(
        service.update('category-1', buildUpdateDto({ parentId: 'category-1' })),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.update('category-1', buildUpdateDto({ parentId: 'category-1' })),
      ).rejects.toThrow('A category cannot be its own parent');
      expect(repositoryUpdate).not.toHaveBeenCalled();
    });

    it('rejects a nonexistent parent on update with 404', async () => {
      repositoryFindById.mockImplementation((id: string) =>
        Promise.resolve(
          id === 'category-1' ? buildEntity({ id: 'category-1' }) : null,
        ),
      );

      await expect(
        service.update('category-1', buildUpdateDto({ parentId: 'missing' })),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repositoryUpdate).not.toHaveBeenCalled();
    });

    it('rejects an inactive parent on update with 409', async () => {
      repositoryFindById.mockImplementation((id: string) =>
        Promise.resolve(
          id === 'category-1'
            ? buildEntity({ id: 'category-1' })
            : buildEntity({ id: 'parent-1', slug: 'archived', isActive: false }),
        ),
      );

      await expect(
        service.update('category-1', buildUpdateDto({ parentId: 'parent-1' })),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repositoryUpdate).not.toHaveBeenCalled();
    });

    it('rejects a circular hierarchy with 409', async () => {
      // A -> B -> C  (A is the parent of B, B is the parent of C).
      // Making C the parent of A would close the loop A -> C -> B -> A.
      repositoryFindById.mockImplementation((id: string) =>
        Promise.resolve(
          buildEntity({
            id,
            slug: id,
            parentId: id === 'a' ? 'b' : id === 'b' ? 'c' : null,
          }),
        ),
      );
      // Walking up from C yields B, then A.
      repositoryFindAncestorIds.mockResolvedValue(['b', 'a']);

      await expect(
        service.update('a', buildUpdateDto({ parentId: 'c' })),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        service.update('a', buildUpdateDto({ parentId: 'c' })),
      ).rejects.toThrow(
        'A category cannot be nested under one of its own descendants',
      );
      expect(repositoryUpdate).not.toHaveBeenCalled();
    });

    it('promotes a category to root when parentId is explicitly null', async () => {
      await service.update('category-1', buildUpdateDto({ parentId: null }));

      expect(repositoryUpdate).toHaveBeenCalledWith('category-1', {
        parentId: null,
      });
      expect(repositoryFindAncestorIds).not.toHaveBeenCalled();
    });

    it('clears the description when it is explicitly null', async () => {
      await service.update('category-1', buildUpdateDto({ description: null }));

      expect(repositoryUpdate).toHaveBeenCalledWith('category-1', {
        description: null,
      });
    });

    it('toggles isActive without touching any other column', async () => {
      await service.update('category-1', buildUpdateDto({ isActive: false }));

      expect(repositoryUpdate).toHaveBeenCalledWith('category-1', {
        isActive: false,
      });
    });

    it('sends an empty patch without writing any column', async () => {
      await service.update('category-1', buildUpdateDto());

      expect(repositoryUpdate).toHaveBeenCalledWith('category-1', {});
    });

    it('maps a slug race on update to 409', async () => {
      repositoryUpdate.mockRejectedValue(buildUniqueViolation());

      await expect(
        service.update('category-1', buildUpdateDto({ slug: 'men' })),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rethrows unrelated database errors untouched', async () => {
      const failure = new Error('deadlock detected');
      repositoryUpdate.mockRejectedValue(failure);

      await expect(
        service.update('category-1', buildUpdateDto({ name: 'Men' })),
      ).rejects.toBe(failure);
    });
  });

  describe('remove', () => {
    it('deletes a category that has no children', async () => {
      repositoryFindById.mockResolvedValue(buildEntity({ id: 'category-1' }));
      repositoryCountChildren.mockResolvedValue(0);
      repositoryDelete.mockResolvedValue(buildEntity({ id: 'category-1' }));

      await expect(service.remove('category-1')).resolves.toBeUndefined();

      expect(repositoryCountChildren).toHaveBeenCalledWith('category-1');
      expect(repositoryDelete).toHaveBeenCalledWith('category-1');
    });

    it('rejects a nonexistent category with 404', async () => {
      repositoryFindById.mockResolvedValue(null);

      await expect(service.remove('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(repositoryDelete).not.toHaveBeenCalled();
    });

    it('rejects deleting a category that still has children with 409', async () => {
      repositoryFindById.mockResolvedValue(buildEntity({ id: 'category-1' }));
      repositoryCountChildren.mockResolvedValue(2);

      await expect(service.remove('category-1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      await expect(service.remove('category-1')).rejects.toThrow(
        'Category cannot be deleted while it still has child categories',
      );
      expect(repositoryDelete).not.toHaveBeenCalled();
    });

    it('maps a concurrent child insert to 409 instead of a raw FK error', async () => {
      repositoryFindById.mockResolvedValue(buildEntity({ id: 'category-1' }));
      repositoryCountChildren.mockResolvedValue(0);
      repositoryDelete.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError(
          'Foreign key constraint failed',
          { code: 'P2003', clientVersion: '7.10.0', meta: { modelName: 'Category' } },
        ),
      );

      await expect(service.remove('category-1')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('rethrows unrelated database errors untouched', async () => {
      repositoryFindById.mockResolvedValue(buildEntity({ id: 'category-1' }));
      repositoryCountChildren.mockResolvedValue(0);
      const failure = new Error('connection lost');
      repositoryDelete.mockRejectedValue(failure);

      await expect(service.remove('category-1')).rejects.toBe(failure);
    });
  });

  describe('response projection', () => {
    it('exposes only the public category fields', async () => {
      repositoryFindAll.mockResolvedValue([
        buildEntity({
          // Extra storage-only fields must never reach the wire.
          internalNote: 'do not leak',
          parent: buildEntity({ id: 'parent-1' }),
          children: [],
        }),
      ]);

      const [category] = await service.findAll();

      expect(Object.keys(category).sort()).toEqual([
        'createdAt',
        'description',
        'id',
        'isActive',
        'name',
        'parentId',
        'slug',
        'updatedAt',
      ]);
      expect(category).not.toHaveProperty('parent');
      expect(category).not.toHaveProperty('children');
      expect(category).not.toHaveProperty('internalNote');
      expect(JSON.stringify(category)).not.toContain('do not leak');
    });

    it('never allows id or timestamps to be overwritten', async () => {
      repositoryFindById.mockResolvedValue(buildEntity({ id: 'category-1' }));
      repositoryUpdate.mockResolvedValue(buildEntity({ id: 'category-1' }));

      const dto = buildUpdateDto({
        name: 'Men',
      }) as UpdateCategoryDto & Record<string, unknown>;
      dto.id = 'hijacked';
      dto.createdAt = new Date('1999-01-01T00:00:00.000Z');
      dto.updatedAt = new Date('1999-01-01T00:00:00.000Z');

      await service.update('category-1', dto);

      const [, data] = repositoryUpdate.mock.calls[0];
      expect(data).not.toHaveProperty('id');
      expect(data).not.toHaveProperty('createdAt');
      expect(data).not.toHaveProperty('updatedAt');
    });
  });
});