import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  VariantOptionsRepository,
  type CreateVariantOptionData,
} from './variant-options.repository.js';

const buildOptionData = (
  overrides: Partial<CreateVariantOptionData> = {},
): CreateVariantOptionData => ({
  variantId: 'v-1',
  optionName: 'Color',
  optionValue: 'Black',
  ...overrides,
});

const buildOption = (overrides: Record<string, unknown> = {}) => ({
  id: 'o-1',
  variantId: 'v-1',
  optionName: 'Color',
  optionValue: 'Black',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

describe('VariantOptionsRepository', () => {
  let repository: VariantOptionsRepository;
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
        VariantOptionsRepository,
        {
          provide: PrismaService,
          useValue: {
            variantOption: {
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

    repository = module.get<VariantOptionsRepository>(VariantOptionsRepository);
  });

  it('should be defined', () => {
    expect(repository).toBeDefined();
  });

  it('create forwards the supplied data unchanged', async () => {
    const data = buildOptionData();
    const option = buildOption();
    create.mockResolvedValue(option);

    await expect(repository.create(data)).resolves.toBe(option);
    expect(create).toHaveBeenCalledWith({ data });
  });

  it('findAllByVariantId scopes to the owner and orders oldest first', async () => {
    const options = [buildOption(), buildOption({ id: 'o-2' })];
    findMany.mockResolvedValue(options);

    await expect(repository.findAllByVariantId('v-1')).resolves.toBe(options);
    expect(findMany).toHaveBeenCalledWith({
      where: { variantId: 'v-1' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  });

  it('findByIdAndVariantId filters by id and owner together', async () => {
    const option = buildOption();
    findFirst.mockResolvedValue(option);

    await expect(repository.findByIdAndVariantId('o-1', 'v-1')).resolves.toBe(
      option,
    );
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 'o-1', variantId: 'v-1' },
    });
  });

  it('findByVariantIdAndOptionName compares case-insensitively', async () => {
    const option = buildOption();
    findFirst.mockResolvedValue(option);

    await expect(
      repository.findByVariantIdAndOptionName('v-1', 'color'),
    ).resolves.toBe(option);
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        variantId: 'v-1',
        optionName: { equals: 'color', mode: 'insensitive' },
      },
    });
  });

  it('findByVariantIdAndOptionName returns null when there is no match', async () => {
    findFirst.mockResolvedValue(null);

    await expect(
      repository.findByVariantIdAndOptionName('v-1', 'Material'),
    ).resolves.toBeNull();
  });

  it('update forwards the id and the supplied data', async () => {
    const option = buildOption({ optionValue: 'White' });
    update.mockResolvedValue(option);

    await expect(
      repository.update('o-1', { optionValue: 'White' }),
    ).resolves.toBe(option);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'o-1' },
      data: { optionValue: 'White' },
    });
  });

  it('delete removes the row by primary key', async () => {
    const option = buildOption();
    deleteFn.mockResolvedValue(option);

    await expect(repository.delete('o-1')).resolves.toBe(option);
    expect(deleteFn).toHaveBeenCalledWith({ where: { id: 'o-1' } });
  });
});
