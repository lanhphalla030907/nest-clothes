import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  ProductAttributesRepository,
  type CreateProductAttributeData,
} from './product-attributes.repository.js';

const buildAttributeData = (
  overrides: Partial<CreateProductAttributeData> = {},
): CreateProductAttributeData => ({
  productId: 'p-1',
  attributeName: 'Material',
  attributeValue: 'Cotton',
  ...overrides,
});

const buildAttribute = (overrides: Record<string, unknown> = {}) => ({
  id: 'a-1',
  productId: 'p-1',
  attributeName: 'Material',
  attributeValue: 'Cotton',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

describe('ProductAttributesRepository', () => {
  let repository: ProductAttributesRepository;
  let create: ReturnType<typeof vi.fn>;
  let findMany: ReturnType<typeof vi.fn>;
  let findFirst: ReturnType<typeof vi.fn>;
  let update: ReturnType<typeof vi.fn>;
  let deleteFn: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    create = vi.fn();
    findMany = vi.fn();
    findFirst = vi.fn();
    update = vi.fn();
    deleteFn = vi.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductAttributesRepository,
        {
          provide: PrismaService,
          useValue: {
            productAttribute: {
              create,
              findMany,
              findFirst,
              update,
              delete: deleteFn,
            },
          },
        },
      ],
    }).compile();

    repository =
      module.get<ProductAttributesRepository>(ProductAttributesRepository);
  });

  it('should be defined', () => {
    expect(repository).toBeDefined();
  });

  it('create forwards the supplied data unchanged', async () => {
    const data = buildAttributeData();
    const attribute = buildAttribute();
    create.mockResolvedValue(attribute);

    await expect(repository.create(data)).resolves.toBe(attribute);
    expect(create).toHaveBeenCalledWith({ data });
  });

  it('findAllByProductId scopes to the owner and orders oldest first', async () => {
    const attributes = [buildAttribute(), buildAttribute({ id: 'a-2' })];
    findMany.mockResolvedValue(attributes);

    await expect(repository.findAllByProductId('p-1')).resolves.toBe(
      attributes,
    );
    expect(findMany).toHaveBeenCalledWith({
      where: { productId: 'p-1' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  });

  it('findByIdAndProductId filters by id and owner together', async () => {
    const attribute = buildAttribute();
    findFirst.mockResolvedValue(attribute);

    await expect(repository.findByIdAndProductId('a-1', 'p-1')).resolves.toBe(
      attribute,
    );
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 'a-1', productId: 'p-1' },
    });
  });

  it('findByProductIdAndAttributeName compares case-insensitively', async () => {
    const attribute = buildAttribute();
    findFirst.mockResolvedValue(attribute);

    await expect(
      repository.findByProductIdAndAttributeName('p-1', 'material'),
    ).resolves.toBe(attribute);
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        productId: 'p-1',
        attributeName: { equals: 'material', mode: 'insensitive' },
      },
    });
  });

  it('findByProductIdAndAttributeName returns null when there is no match', async () => {
    findFirst.mockResolvedValue(null);

    await expect(
      repository.findByProductIdAndAttributeName('p-1', 'Material'),
    ).resolves.toBeNull();
  });

  it('update forwards the id and the supplied data', async () => {
    const attribute = buildAttribute({ attributeValue: 'Linen' });
    update.mockResolvedValue(attribute);

    await expect(
      repository.update('a-1', { attributeValue: 'Linen' }),
    ).resolves.toBe(attribute);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'a-1' },
      data: { attributeValue: 'Linen' },
    });
  });

  it('delete removes the row by primary key', async () => {
    const attribute = buildAttribute();
    deleteFn.mockResolvedValue(attribute);

    await expect(repository.delete('a-1')).resolves.toBe(attribute);
    expect(deleteFn).toHaveBeenCalledWith({ where: { id: 'a-1' } });
  });
});
