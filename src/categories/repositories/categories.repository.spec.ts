import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  CategoriesRepository,
  type CreateCategoryData,
} from './categories.repository.js';

const buildCategoryData = (
  overrides: Partial<CreateCategoryData> = {},
): CreateCategoryData => ({
  name: 'Clothing',
  slug: 'clothing',
  description: null,
  parentId: null,
  isActive: true,
  ...overrides,
});

const buildCategory = (overrides: Record<string, unknown> = {}) => ({
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

describe('CategoriesRepository', () => {
  let repository: CategoriesRepository;
  let create: ReturnType<typeof vi.fn>;
  let findMany: ReturnType<typeof vi.fn>;
  let findUnique: ReturnType<typeof vi.fn>;
  let update: ReturnType<typeof vi.fn>;
  let deleteFn: ReturnType<typeof vi.fn>;
  let count: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    create = vi.fn();
    findMany = vi.fn();
    findUnique = vi.fn();
    update = vi.fn();
    deleteFn = vi.fn();
    count = vi.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CategoriesRepository,
        {
          provide: PrismaService,
          useValue: {
            category: { create, findMany, findUnique, update, delete: deleteFn, count },
          },
        },
      ],
    }).compile();

    repository = module.get<CategoriesRepository>(CategoriesRepository);
  });

  it('should be defined', () => {
    expect(repository).toBeDefined();
  });

  it('create forwards the supplied data unchanged', async () => {
    const data = buildCategoryData({ description: 'All clothing' });
    const category = buildCategory();
    create.mockResolvedValue(category);

    await expect(repository.create(data)).resolves.toBe(category);
    expect(create).toHaveBeenCalledWith({ data });
  });

  it('findAll returns every category ordered by name', async () => {
    const categories = [buildCategory({ name: 'Clothing' }), buildCategory({ name: 'Men' })];
    findMany.mockResolvedValue(categories);

    await expect(repository.findAll()).resolves.toBe(categories);
    expect(findMany).toHaveBeenCalledWith({ orderBy: { name: 'asc' } });
  });

  it('findById queries the primary key and returns the entity', async () => {
    const category = buildCategory();
    findUnique.mockResolvedValue(category);

    await expect(repository.findById('category-1')).resolves.toBe(category);
    expect(findUnique).toHaveBeenCalledWith({ where: { id: 'category-1' } });
  });

  it('findById returns null when no category matches', async () => {
    findUnique.mockResolvedValue(null);

    await expect(repository.findById('missing')).resolves.toBeNull();
  });

  it('findBySlug queries the unique slug and returns the entity', async () => {
    const category = buildCategory();
    findUnique.mockResolvedValue(category);

    await expect(repository.findBySlug('clothing')).resolves.toBe(category);
    expect(findUnique).toHaveBeenCalledWith({ where: { slug: 'clothing' } });
  });

  it('update forwards only the given columns', async () => {
    const category = buildCategory({ name: 'Outerwear' });
    update.mockResolvedValue(category);

    await expect(
      repository.update('category-1', { name: 'Outerwear' }),
    ).resolves.toBe(category);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'category-1' },
      data: { name: 'Outerwear' },
    });
  });

  it('delete removes a single category by id without cascading', async () => {
    const category = buildCategory();
    deleteFn.mockResolvedValue(category);

    await expect(repository.delete('category-1')).resolves.toBe(category);
    expect(deleteFn).toHaveBeenCalledWith({ where: { id: 'category-1' } });
  });

  it('countChildren counts rows filtered by parentId', async () => {
    count.mockResolvedValue(2);

    await expect(repository.countChildren('category-1')).resolves.toBe(2);
    expect(count).toHaveBeenCalledWith({ where: { parentId: 'category-1' } });
  });

  describe('findAncestorIds', () => {
    it('returns ancestors from nearest to furthest up the chain', async () => {
      findUnique
        .mockResolvedValueOnce(buildCategory({ id: 'c', parentId: 'b' }))
        .mockResolvedValueOnce(buildCategory({ id: 'b', parentId: 'a' }))
        .mockResolvedValueOnce(buildCategory({ id: 'a', parentId: null }));

      await expect(repository.findAncestorIds('c')).resolves.toEqual(['b', 'a']);
      expect(findUnique).toHaveBeenCalledTimes(3);
    });

    it('returns an empty list for a root category', async () => {
      findUnique.mockResolvedValueOnce(buildCategory({ parentId: null }));

      await expect(repository.findAncestorIds('a')).resolves.toEqual([]);
      expect(findUnique).toHaveBeenCalledTimes(1);
    });

    it('returns an empty list when the starting category does not exist', async () => {
      findUnique.mockResolvedValueOnce(null);

      await expect(repository.findAncestorIds('missing')).resolves.toEqual([]);
    });

    it('stops walking instead of looping forever on already cyclic data', async () => {
      // a -> b -> a. The service prevents this, but the walk must stay bounded.
      findUnique.mockImplementation((args: { where: { id: string } }) =>
        Promise.resolve(
          args.where.id === 'a'
            ? buildCategory({ id: 'a', parentId: 'b' })
            : buildCategory({ id: 'b', parentId: 'a' }),
        ),
      );

      await expect(repository.findAncestorIds('a')).resolves.toEqual(['b']);
    });
  });
});