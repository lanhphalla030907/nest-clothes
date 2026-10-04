import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  InventoryRepository,
  type CreateInventoryData,
} from './inventory.repository.js';

const buildInventoryData = (
  overrides: Partial<CreateInventoryData> = {},
): CreateInventoryData => ({
  variantId: 'v-1',
  quantity: 10,
  reservedQuantity: 2,
  ...overrides,
});

const buildInventory = (overrides: Record<string, unknown> = {}) => ({
  id: 'i-1',
  variantId: 'v-1',
  quantity: 10,
  reservedQuantity: 2,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

describe('InventoryRepository', () => {
  let repository: InventoryRepository;
  let create: ReturnType<typeof vi.fn>;
  let findUnique: ReturnType<typeof vi.fn>;
  let update: ReturnType<typeof vi.fn>;
  let transaction: ReturnType<typeof vi.fn>;
  let executeRaw: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    create = vi.fn();
    findUnique = vi.fn();
    update = vi.fn();
    transaction = vi.fn();
    executeRaw = vi.fn().mockResolvedValue(1);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InventoryRepository,
        {
          provide: PrismaService,
          useValue: {
            inventory: { create, findUnique, update },
            $transaction: transaction,
            $executeRaw: executeRaw,
          },
        },
      ],
    }).compile();

    repository = module.get<InventoryRepository>(InventoryRepository);
  });

  it('should be defined', () => {
    expect(repository).toBeDefined();
  });

  it('runInTransaction delegates to $transaction and forwards its result', async () => {
    const expected = buildInventory();
    transaction.mockImplementation(
      (work: (tx: unknown) => Promise<unknown>) => work({ tx: true }),
    );
    const work = vi.fn().mockResolvedValue(expected);

    await expect(repository.runInTransaction(work)).resolves.toBe(expected);
    expect(transaction).toHaveBeenCalledWith(work);
    expect(work).toHaveBeenCalledWith({ tx: true });
  });

  it('create forwards the supplied data on the default client', async () => {
    const data = buildInventoryData();
    const inventory = buildInventory();
    create.mockResolvedValue(inventory);

    await expect(repository.create(data)).resolves.toBe(inventory);
    expect(create).toHaveBeenCalledWith({ data });
  });

  it('create uses the transaction client when one is supplied', async () => {
    const data = buildInventoryData();
    const inventory = buildInventory();
    const txCreate = vi.fn().mockResolvedValue(inventory);

    await expect(
      repository.create(data, { inventory: { create: txCreate } } as never),
    ).resolves.toBe(inventory);
    expect(txCreate).toHaveBeenCalledWith({ data });
    expect(create).not.toHaveBeenCalled();
  });

  it('findByVariantId looks the row up by its unique owner', async () => {
    const inventory = buildInventory();
    findUnique.mockResolvedValue(inventory);

    await expect(repository.findByVariantId('v-1')).resolves.toBe(inventory);
    expect(findUnique).toHaveBeenCalledWith({ where: { variantId: 'v-1' } });
  });

  it('findByVariantId returns null when the variant has no inventory', async () => {
    findUnique.mockResolvedValue(null);

    await expect(repository.findByVariantId('v-1')).resolves.toBeNull();
  });

  it('update writes only the supplied counters against the unique owner', async () => {
    const inventory = buildInventory({ reservedQuantity: 4 });
    update.mockResolvedValue(inventory);

    await expect(
      repository.update('v-1', { reservedQuantity: 4 }),
    ).resolves.toBe(inventory);
    expect(update).toHaveBeenCalledWith({
      where: { variantId: 'v-1' },
      data: { reservedQuantity: 4 },
    });
  });

  it('update uses the transaction client when one is supplied', async () => {
    const inventory = buildInventory({ quantity: 7 });
    const txUpdate = vi.fn().mockResolvedValue(inventory);

    await expect(
      repository.update(
        'v-1',
        { quantity: 7 },
        { inventory: { update: txUpdate } } as never,
      ),
    ).resolves.toBe(inventory);
    expect(txUpdate).toHaveBeenCalledWith({
      where: { variantId: 'v-1' },
      data: { quantity: 7 },
    });
    expect(update).not.toHaveBeenCalled();
  });

  /**
   * `reserve` is the one method whose safety is entirely in its SQL, so these
   * assertions are about the *statement*, not the result: that the guard and the
   * increment are in one statement, that the guard compares the row's own two
   * columns, and that `quantity` is never in the SET list.
   *
   * Whether the statement is genuinely atomic under concurrency is PostgreSQL's
   * claim to make and is proved in `test/checkout.e2e-spec.ts` against a real
   * database with two real connections. No mock can settle that.
   */
  describe('reserve', () => {
    /** Reads the single SQL string the tagged template produced. */
    const reservedSql = () => {
      const [strings, ...values] = executeRaw.mock.calls[0] as [
        TemplateStringsArray,
        ...unknown[],
      ];

      return { sql: strings.join('?'), values };
    };

    it('guards the increment against the row own available stock', async () => {
      await repository.reserve('v-1', 3);

      const { sql, values } = reservedSql();
      // The guard compares two columns of the same row, which is precisely what
      // Prisma's query API cannot express and why this is raw SQL.
      expect(sql).toContain('"quantity" - "reserved_quantity" >= ?');
      expect(values).toEqual([3, 'v-1', 3]);
    });

    it('increments reserved_quantity rather than setting it', async () => {
      await repository.reserve('v-1', 3);

      const { sql } = reservedSql();
      // "increment" must be arithmetic on the stored value; a literal assignment is
      // exactly the read-modify-write this replaces.
      expect(sql).toContain('"reserved_quantity" = "reserved_quantity" + ?');
      expect(sql).not.toMatch(/SET\s+"reserved_quantity"\s*=\s*\?/);
    });

    it('never writes quantity: reserving is not restocking', async () => {
      await repository.reserve('v-1', 3);

      const { sql } = reservedSql();
      const setClause = sql.slice(
        sql.indexOf('SET'),
        sql.indexOf('WHERE'),
      );

      expect(setClause).not.toContain('"quantity"');
    });

    it('updates updated_at explicitly, since Prisma does not do it for raw SQL', async () => {
      await repository.reserve('v-1', 3);

      expect(reservedSql().sql).toContain('"updated_at" = now()');
    });

    it('addresses the row by its unique variant id', async () => {
      await repository.reserve('v-1', 3);

      expect(reservedSql().sql).toContain('WHERE "variant_id" = ?::uuid');
    });

    it('reports 1 when the hold was taken', async () => {
      executeRaw.mockResolvedValue(1);

      await expect(repository.reserve('v-1', 3)).resolves.toBe(1);
    });

    it('reports 0 when the guard refused it', async () => {
      // Zero is the answer the service turns into a 409, and it is the only signal
      // it gets that another writer won the race.
      executeRaw.mockResolvedValue(0);

      await expect(repository.reserve('v-1', 3)).resolves.toBe(0);
    });

    it('uses the transaction client when one is supplied', async () => {
      const txExecuteRaw = vi.fn().mockResolvedValue(1);

      await expect(
        repository.reserve('v-1', 3, { $executeRaw: txExecuteRaw } as never),
      ).resolves.toBe(1);
      expect(txExecuteRaw).toHaveBeenCalledTimes(1);
      expect(executeRaw).not.toHaveBeenCalled();
    });
  });
});
