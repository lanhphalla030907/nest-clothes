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
  combinationKey: 'DEFAULT',
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
  let transaction: ReturnType<typeof vi.fn>;
  let txProductUpdate: ReturnType<typeof vi.fn>;
  let txVariantFindFirst: ReturnType<typeof vi.fn>;
  let txVariantUpdate: ReturnType<typeof vi.fn>;
  let txVariantCreate: ReturnType<typeof vi.fn>;
  let txVariantCount: ReturnType<typeof vi.fn>;
  let txOptionCount: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    create = vi.fn();
    findMany = vi.fn();
    findFirst = vi.fn();
    findUnique = vi.fn();
    update = vi.fn();
    deleteFn = vi.fn();
    txProductUpdate = vi.fn();
    txVariantFindFirst = vi.fn();
    txVariantUpdate = vi.fn();
    txVariantCreate = vi.fn();
    txVariantCount = vi.fn().mockResolvedValue(0);
    txOptionCount = vi.fn().mockResolvedValue(0);
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'p-1' }]),
      product: { update: txProductUpdate },
      productOption: { count: txOptionCount },
      productVariant: {
        count: txVariantCount,
        create: txVariantCreate,
        findFirst: txVariantFindFirst,
        update: txVariantUpdate,
      },
    };
    transaction = vi.fn((callback: (client: typeof tx) => unknown) =>
      Promise.resolve(callback(tx)),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductVariantsRepository,
        {
          provide: PrismaService,
          useValue: {
            $transaction: transaction,
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

  it('creates a default variant under the product lock and increments its revision', async () => {
    const data = buildVariantData();
    const variant = buildVariant();
    txVariantCreate.mockResolvedValue(variant);

    await expect(repository.createDefaultIfUnconfigured(data)).resolves.toBe(
      variant,
    );
    expect(txVariantCreate).toHaveBeenCalledWith({ data });
    expect(txProductUpdate).toHaveBeenCalledWith({
      where: { id: 'p-1' },
      data: { optionsRevision: { increment: 1 } },
    });
  });

  it('does not create a default variant when options or variants already exist', async () => {
    txOptionCount.mockResolvedValue(1);

    await expect(
      repository.createDefaultIfUnconfigured(buildVariantData()),
    ).resolves.toBeNull();
    expect(txVariantCreate).not.toHaveBeenCalled();
    expect(txProductUpdate).not.toHaveBeenCalled();
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

  it('findByIdsAndProductId validates the whole requested set against its product', async () => {
    const variants = [buildVariant(), buildVariant({ id: 'v-2' })];
    findMany.mockResolvedValue(variants);

    await expect(
      repository.findByIdsAndProductId(['v-1', 'v-2'], 'p-1'),
    ).resolves.toBe(variants);
    expect(findMany).toHaveBeenCalledWith({
      where: { id: { in: ['v-1', 'v-2'] }, productId: 'p-1' },
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

  it('updates an owned variant under the product lock and advances the revision', async () => {
    const variant = buildVariant({ sku: 'TSHIRT-BLK-L' });
    txVariantFindFirst.mockResolvedValue({ id: 'v-1' });
    txVariantUpdate.mockResolvedValue(variant);

    await expect(
      repository.updateForProduct('p-1', 'v-1', { sku: 'TSHIRT-BLK-L' }),
    ).resolves.toBe(variant);
    expect(txVariantFindFirst).toHaveBeenCalledWith({
      where: { id: 'v-1', productId: 'p-1' },
      select: { id: true },
    });
    expect(txProductUpdate).toHaveBeenCalledWith({
      where: { id: 'p-1' },
      data: { optionsRevision: { increment: 1 } },
    });
  });

  it('does not update or revise a variant owned by another product', async () => {
    txVariantFindFirst.mockResolvedValue(null);

    await expect(
      repository.updateForProduct('p-1', 'v-1', { isActive: false }),
    ).resolves.toBeNull();
    expect(txVariantUpdate).not.toHaveBeenCalled();
    expect(txProductUpdate).not.toHaveBeenCalled();
  });

  it('delete removes the row by primary key', async () => {
    const variant = buildVariant();
    deleteFn.mockResolvedValue(variant);

    await expect(repository.delete('v-1')).resolves.toBe(variant);
    expect(deleteFn).toHaveBeenCalledWith({ where: { id: 'v-1' } });
  });
});
