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

  beforeEach(async () => {
    create = vi.fn();
    findMany = vi.fn();
    findUnique = vi.fn();
    update = vi.fn();
    deleteFn = vi.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsRepository,
        {
          provide: PrismaService,
          useValue: {
            product: { create, findMany, findUnique, update, delete: deleteFn },
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

  it('findAll returns every product newest first', async () => {
    const products = [buildProduct(), buildProduct({ id: 'p-2' })];
    findMany.mockResolvedValue(products);

    await expect(repository.findAll()).resolves.toBe(products);
    expect(findMany).toHaveBeenCalledWith({
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
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
});