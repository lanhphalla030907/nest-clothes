import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  ProductVariantsRepository,
  type CreateProductVariantData,
} from './product-variants.repository.js';

const buildVariantData = (
  overrides: Partial<CreateProductVariantData> = {},
): CreateProductVariantData => ({
  productId: 'p-1',
  sku: 'TSHIRT-BLK-M',
  price: '19.99',
  isActive: true,
  ...overrides,
});

const buildVariant = (overrides: Record<string, unknown> = {}) => ({
  id: 'v-1',
  productId: 'p-1',
  sku: 'TSHIRT-BLK-M',
  price: { toFixed: () => '19.99' },
  isActive: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

describe('ProductVariantsRepository', () => {
  let repository: ProductVariantsRepository;
  let create: ReturnType<typeof vi.fn>;
  let findMany: ReturnType<typeof vi.fn>;
  let findFirst: ReturnType<typeof vi.fn>;
  let findUnique: ReturnType<typeof vi.fn>;
  let update: ReturnType<typeof vi.fn>;
  let deleteFn: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    create = vi.fn();
    findMany = vi.fn();
    findFirst = vi.fn();
    findUnique = vi.fn();
    update = vi.fn();
    deleteFn = vi.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductVariantsRepository,
        {
          provide: PrismaService,
          useValue: {
            productVariant: {
              create,
              findMany,
              findFirst,
              findUnique,
              update,
              delete: deleteFn,
            },
          },
        },
      ],
    }).compile();

    repository = module.get<ProductVariantsRepository>(
      ProductVariantsRepository,
    );
  });

  it('should be defined', () => {
    expect(repository).toBeDefined();
  });

  it('create forwards the supplied data unchanged', async () => {
    const data = buildVariantData();
    const variant = buildVariant();
    create.mockResolvedValue(variant);

    await expect(repository.create(data)).resolves.toBe(variant);
    expect(create).toHaveBeenCalledWith({ data });
  });

  it('findAllByProductId scopes to the owner and orders oldest first', async () => {
    const variants = [buildVariant(), buildVariant({ id: 'v-2' })];
    findMany.mockResolvedValue(variants);

    await expect(repository.findAllByProductId('p-1')).resolves.toBe(variants);
    expect(findMany).toHaveBeenCalledWith({
      where: { productId: 'p-1' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  });

  it('findByIdAndProductId filters by id and owner together', async () => {
    const variant = buildVariant();
    findFirst.mockResolvedValue(variant);

    await expect(repository.findByIdAndProductId('v-1', 'p-1')).resolves.toBe(
      variant,
    );
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 'v-1', productId: 'p-1' },
    });
  });

  it('findBySku queries the unique sku and returns the entity', async () => {
    const variant = buildVariant();
    findUnique.mockResolvedValue(variant);

    await expect(repository.findBySku('TSHIRT-BLK-M')).resolves.toBe(variant);
    expect(findUnique).toHaveBeenCalledWith({
      where: { sku: 'TSHIRT-BLK-M' },
    });
  });

  it('findBySku returns null when no variant carries the sku', async () => {
    findUnique.mockResolvedValue(null);
    await expect(repository.findBySku('MISSING')).resolves.toBeNull();
  });

  it('update forwards the id and the supplied data', async () => {
    const variant = buildVariant({ sku: 'TSHIRT-BLK-L' });
    update.mockResolvedValue(variant);

    await expect(
      repository.update('v-1', { sku: 'TSHIRT-BLK-L' }),
    ).resolves.toBe(variant);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'v-1' },
      data: { sku: 'TSHIRT-BLK-L' },
    });
  });

  it('delete removes the row by primary key', async () => {
    const variant = buildVariant();
    deleteFn.mockResolvedValue(variant);

    await expect(repository.delete('v-1')).resolves.toBe(variant);
    expect(deleteFn).toHaveBeenCalledWith({ where: { id: 'v-1' } });
  });
});
