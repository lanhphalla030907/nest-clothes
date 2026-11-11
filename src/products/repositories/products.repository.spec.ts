import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  ProductsRepository,
  type CreateProductData,
} from './products.repository.js';

const buildProductData = (
  overrides: Partial<CreateProductData> = {},
): CreateProductData => ({
  categoryId: 'c-1',
  name: 'Oversized T-Shirt',
  slug: 'oversized-t-shirt',
  description: 'Premium oversized cotton t-shirt',
  basePrice: '19.99',
  status: 'DRAFT',
  isActive: true,
  ...overrides,
});

const buildProduct = (overrides: Record<string, unknown> = {}) => ({
  id: 'p-1',
  categoryId: 'c-1',
  name: 'Oversized T-Shirt',
  slug: 'oversized-t-shirt',
  description: 'Premium oversized cotton t-shirt',
  basePrice: { toFixed: () => '19.99' },
  status: 'DRAFT',
  isActive: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

describe('ProductsRepository', () => {
  let repository: ProductsRepository;
  let create: ReturnType<typeof vi.fn>;
  let findMany: ReturnType<typeof vi.fn>;
  let findUnique: ReturnType<typeof vi.fn>;
  let update: ReturnType<typeof vi.fn>;
  let deleteFn: ReturnType<typeof vi.fn>;
  let queryRaw: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    create = vi.fn();
    findMany = vi.fn();
    findUnique = vi.fn();
    update = vi.fn();
    deleteFn = vi.fn();
    queryRaw = vi.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsRepository,
        {
          provide: PrismaService,
          useValue: {
            product: { create, findMany, findUnique, update, delete: deleteFn },
            $queryRaw: queryRaw,
          },
        },
      ],
    }).compile();

    repository = module.get<ProductsRepository>(ProductsRepository);
  });

  it('should be defined', () => {
    expect(repository).toBeDefined();
  });

  it('create forwards the supplied data unchanged', async () => {
    const data = buildProductData({ description: null });
    const product = buildProduct({ description: null });
    create.mockResolvedValue(product);

    await expect(repository.create(data)).resolves.toBe(product);
    expect(create).toHaveBeenCalledWith({ data });
  });

  it('findAll returns every product newest first, unfiltered', async () => {
    const products = [buildProduct(), buildProduct({ id: 'p-2' })];
    findMany.mockResolvedValue(products);

    await expect(repository.findAll()).resolves.toBe(products);
    expect(findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
  });

  it('findMany filters by status alone', async () => {
    findMany.mockResolvedValue([]);

    await repository.findMany({ status: 'ACTIVE' });

    expect(findMany).toHaveBeenCalledWith({
      where: { status: 'ACTIVE' },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
  });

  it('findMany filters by isActive and categoryId together', async () => {
    findMany.mockResolvedValue([]);

    await repository.findMany({ isActive: false, categoryId: 'c-9' });

    expect(findMany).toHaveBeenCalledWith({
      where: { isActive: false, categoryId: 'c-9' },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
  });

  it('findMany matches search case-insensitively against name or slug', async () => {
    findMany.mockResolvedValue([]);

    await repository.findMany({ search: 'Peacoat' });

    expect(findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { name: { contains: 'Peacoat', mode: 'insensitive' } },
          { slug: { contains: 'Peacoat', mode: 'insensitive' } },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
  });

  it('findMany omits an absent filter entirely rather than matching on undefined', async () => {
    findMany.mockResolvedValue([]);

    await repository.findMany({ isActive: true });

    expect(findMany).toHaveBeenCalledWith({
      // `status: undefined` would be a real `WHERE status = NULL` in Prisma's eyes.
      where: { isActive: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
  });

  it('updateLifecycle writes the lifecycle columns through the same primitive', async () => {
    const product = buildProduct({ status: 'ACTIVE', isActive: false });
    update.mockResolvedValue(product);

    await expect(
      repository.updateLifecycle('p-1', { status: 'ACTIVE', isActive: false }),
    ).resolves.toBe(product);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'p-1' },
      data: { status: 'ACTIVE', isActive: false },
    });
  });

  it('findById queries the primary key and returns the entity', async () => {
    const product = buildProduct();
    findUnique.mockResolvedValue(product);

    await expect(repository.findById('p-1')).resolves.toBe(product);
    expect(findUnique).toHaveBeenCalledWith({ where: { id: 'p-1' } });
  });

  it('findById returns null when no product matches', async () => {
    findUnique.mockResolvedValue(null);

    await expect(repository.findById('missing')).resolves.toBeNull();
  });

  it('findBySlug queries the unique slug and returns the entity', async () => {
    const product = buildProduct();
    findUnique.mockResolvedValue(product);

    await expect(repository.findBySlug('oversized-t-shirt')).resolves.toBe(product);
    expect(findUnique).toHaveBeenCalledWith({ where: { slug: 'oversized-t-shirt' } });
  });

  it('update forwards only the given columns', async () => {
    const product = buildProduct({ name: 'Oversized Tee' });
    update.mockResolvedValue(product);

    await expect(repository.update('p-1', { name: 'Oversized Tee' })).resolves.toBe(
      product,
    );
    expect(update).toHaveBeenCalledWith({
      where: { id: 'p-1' },
      data: { name: 'Oversized Tee' },
    });
  });

  it('delete removes a single product by id', async () => {
    const product = buildProduct();
    deleteFn.mockResolvedValue(product);

    await expect(repository.delete('p-1')).resolves.toBe(product);
    expect(deleteFn).toHaveBeenCalledWith({ where: { id: 'p-1' } });
  });

  describe('findPublicProducts', () => {
    it('executes filtered count and id queries and returns entities in order', async () => {
      const p1 = buildProduct({ id: 'p-1', name: 'Product 1' });
      const p2 = buildProduct({ id: 'p-2', name: 'Product 2' });

      // Call 1: count query [{ count: 2 }]
      // Calls 2-5: getFilterOptions (categories, priceRange, sizes, colors)
      // Call 6: id query [{ id: 'p-2' }, { id: 'p-1' }]
      queryRaw
        .mockResolvedValueOnce([{ count: 2 }])
        .mockResolvedValueOnce([{ id: 'c-1', name: 'Tees', slug: 'tees', count: 2 }])
        .mockResolvedValueOnce([{ min_price: 15, max_price: 50 }])
        .mockResolvedValueOnce([{ size: 'M' }, { size: 'L' }])
        .mockResolvedValueOnce([{ color: 'Black' }])
        .mockResolvedValueOnce([{ id: 'p-2' }, { id: 'p-1' }]);

      findMany.mockResolvedValue([p1, p2]);

      const result = await repository.findPublicProducts({
        category: 'tees',
        minPrice: 10,
        maxPrice: 60,
        size: 'M',
        color: 'Black',
        inStock: true,
        sortBy: 'price_asc',
        page: 1,
        limit: 10,
      });

      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(10);
      expect(result.totalPages).toBe(1);
      expect(result.products).toHaveLength(2);
      expect(result.products[0].id).toBe('p-2');
      expect(result.products[1].id).toBe('p-1');
      expect(result.filterOptions.categories).toHaveLength(1);
      expect(result.filterOptions.sizes).toEqual(['M', 'L']);
      expect(result.filterOptions.colors).toEqual(['Black']);
    });

    it('returns empty array immediately when total count is 0', async () => {
      queryRaw
        .mockResolvedValueOnce([{ count: 0 }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ min_price: 0, max_price: 0 }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await repository.findPublicProducts({ search: 'nonexistent' });

      expect(result.total).toBe(0);
      expect(result.products).toEqual([]);
      expect(result.totalPages).toBe(0);
      expect(findMany).not.toHaveBeenCalled();
    });
  });

  describe('getFilterOptions', () => {
    it('returns aggregated categories, price range, sizes, and colors', async () => {
      queryRaw
        .mockResolvedValueOnce([{ id: 'c-1', name: 'Hoodies', slug: 'hoodies', count: 5 }])
        .mockResolvedValueOnce([{ min_price: 25.5, max_price: 120 }])
        .mockResolvedValueOnce([{ size: 'S' }, { size: 'XL' }])
        .mockResolvedValueOnce([{ color: 'Heather Grey' }]);

      const options = await repository.getFilterOptions();

      expect(options.categories).toEqual([
        { id: 'c-1', name: 'Hoodies', slug: 'hoodies', count: 5 },
      ]);
      expect(options.priceRange).toEqual({ min: 25.5, max: 120 });
      expect(options.sizes).toEqual(['S', 'XL']);
      expect(options.colors).toEqual(['Heather Grey']);
    });
  });
});