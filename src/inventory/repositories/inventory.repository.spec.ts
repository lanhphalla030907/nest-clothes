import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  InventoryRepository,
  type CreateInventoryData,
  type InventoryWithVariant,
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
  let findMany: ReturnType<typeof vi.fn>;
  let update: ReturnType<typeof vi.fn>;
  let transaction: ReturnType<typeof vi.fn>;
  let executeRaw: ReturnType<typeof vi.fn>;
  let queryRaw: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    create = vi.fn();
    findUnique = vi.fn();
    findMany = vi.fn().mockResolvedValue([]);
    update = vi.fn();
    transaction = vi.fn();
    executeRaw = vi.fn().mockResolvedValue(1);
    queryRaw = vi.fn().mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InventoryRepository,
        {
          provide: PrismaService,
          useValue: {
            inventory: { create, findUnique, findMany, update },
            $transaction: transaction,
            $executeRaw: executeRaw,
            $queryRaw: queryRaw,
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
    transaction.mockImplementation((work: (tx: unknown) => Promise<unknown>) =>
      work({ tx: true }),
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

  describe('findByVariantIds', () => {
    it('fetches every requested row in one IN query', async () => {
      const rows = [buildInventory(), buildInventory({ variantId: 'v-2' })];
      findMany.mockResolvedValue(rows);

      await expect(repository.findByVariantIds(['v-1', 'v-2'])).resolves.toBe(
        rows,
      );
      expect(findMany).toHaveBeenCalledWith({
        where: { variantId: { in: ['v-1', 'v-2'] } },
      });
    });

    describe('lockByVariantIds', () => {
      it('locks rows in stable variant-id order inside the supplied transaction', async () => {
        const queryRaw = vi.fn().mockResolvedValue([]);

        await repository.lockByVariantIds(
          [
            'f0000000-0000-4000-8000-000000000001',
            'a0000000-0000-4000-8000-000000000001',
          ],
          { $queryRaw: queryRaw } as never,
        );

        expect(queryRaw).toHaveBeenCalledTimes(1);
        expect(queryRaw.mock.calls[0][1]).toEqual([
          'a0000000-0000-4000-8000-000000000001',
          'f0000000-0000-4000-8000-000000000001',
        ]);
        expect(queryRaw.mock.calls[0][0].join('')).toContain('FOR UPDATE');
      });

      it('does not query for an empty id list', async () => {
        const queryRaw = vi.fn();

        await repository.lockByVariantIds([], { $queryRaw: queryRaw } as never);

        expect(queryRaw).not.toHaveBeenCalled();
      });
    });

    it('returns an empty result without querying for an empty id list', async () => {
      await expect(repository.findByVariantIds([])).resolves.toEqual([]);
      expect(findMany).not.toHaveBeenCalled();
    });

    it('uses the transaction client when one is supplied', async () => {
      const txFindMany = vi.fn().mockResolvedValue([]);

      await repository.findByVariantIds(['v-1'], {
        inventory: { findMany: txFindMany },
      } as never);

      expect(txFindMany).toHaveBeenCalledWith({
        where: { variantId: { in: ['v-1'] } },
      });
      expect(findMany).not.toHaveBeenCalled();
    });
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
      repository.update('v-1', { quantity: 7 }, {
        inventory: { update: txUpdate },
      } as never),
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
      const setClause = sql.slice(sql.indexOf('SET'), sql.indexOf('WHERE'));

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

  /** Reads the single SQL string and bound values the tagged template produced. */
  const executedStatement = () => {
    const [strings, ...values] = executeRaw.mock.calls[0] as [
      TemplateStringsArray,
      ...unknown[],
    ];

    return { sql: strings.join('?'), values };
  };

  describe('releaseReserved', () => {
    it('subtracts from reserved_quantity in the SET clause', async () => {
      await repository.releaseReserved('v-1', 3);

      const { sql } = executedStatement();

      expect(sql).toContain('"reserved_quantity" = "reserved_quantity" - ?');
      expect(sql).not.toMatch(/SET\s+"reserved_quantity"\s*=\s*\?/);
    });

    it('guards the release against the row own reserved quantity', async () => {
      await repository.releaseReserved('v-1', 3);

      const { sql, values } = executedStatement();

      expect(sql).toContain('"reserved_quantity" >= ?');
      expect(values).toEqual([3, 'v-1', 3]);
    });

    it('never writes quantity: releasing a hold is not a stock movement', async () => {
      await repository.releaseReserved('v-1', 3);

      const { sql } = executedStatement();
      const setClause = sql.slice(sql.indexOf('SET'), sql.indexOf('WHERE'));

      expect(setClause).not.toContain('"quantity"');
    });

    it('updates updated_at explicitly', async () => {
      await repository.releaseReserved('v-1', 3);

      expect(executedStatement().sql).toContain('"updated_at" = now()');
    });

    it('addresses the row by its unique variant id', async () => {
      await repository.releaseReserved('v-1', 3);

      expect(executedStatement().sql).toContain('WHERE "variant_id" = ?::uuid');
    });

    it('reports 1 when the reservation was released', async () => {
      executeRaw.mockResolvedValue(1);

      await expect(repository.releaseReserved('v-1', 3)).resolves.toBe(1);
    });

    it('reports 0 when the guard refused it', async () => {
      executeRaw.mockResolvedValue(0);

      await expect(repository.releaseReserved('v-1', 3)).resolves.toBe(0);
    });

    it('rejects zero, negative and fractional quantities before any SQL', async () => {
      await expect(repository.releaseReserved('v-1', 0)).rejects.toBeInstanceOf(
        RangeError,
      );
      await expect(
        repository.releaseReserved('v-1', -1),
      ).rejects.toBeInstanceOf(RangeError);
      await expect(
        repository.releaseReserved('v-1', 1.5),
      ).rejects.toBeInstanceOf(RangeError);
      expect(executeRaw).not.toHaveBeenCalled();
    });

    it('uses the transaction client when one is supplied', async () => {
      const txExecuteRaw = vi.fn().mockResolvedValue(1);

      await expect(
        repository.releaseReserved('v-1', 3, {
          $executeRaw: txExecuteRaw,
        } as never),
      ).resolves.toBe(1);
      expect(txExecuteRaw).toHaveBeenCalledTimes(1);
      expect(executeRaw).not.toHaveBeenCalled();
    });
  });

  describe('commitReserved', () => {
    it('subtracts from both counters in the SET clause', async () => {
      await repository.commitReserved('v-1', 3);

      const { sql } = executedStatement();

      expect(sql).toContain('"quantity" = "quantity" - ?');
      expect(sql).toContain('"reserved_quantity" = "reserved_quantity" - ?');
    });

    it('requires both physical stock and reserved stock to cover the movement', async () => {
      await repository.commitReserved('v-1', 3);

      const { sql, values } = executedStatement();

      expect(sql).toContain('"quantity" >= ?');
      expect(sql).toContain('"reserved_quantity" >= ?');
      expect(values).toEqual([3, 3, 'v-1', 3, 3]);
    });

    it('updates updated_at explicitly', async () => {
      await repository.commitReserved('v-1', 3);

      expect(executedStatement().sql).toContain('"updated_at" = now()');
    });

    it('addresses the row by its unique variant id', async () => {
      await repository.commitReserved('v-1', 3);

      expect(executedStatement().sql).toContain('WHERE "variant_id" = ?::uuid');
    });

    it('reports 1 when the commitment was applied', async () => {
      executeRaw.mockResolvedValue(1);

      await expect(repository.commitReserved('v-1', 3)).resolves.toBe(1);
    });

    it('reports 0 when the guard refused it', async () => {
      executeRaw.mockResolvedValue(0);

      await expect(repository.commitReserved('v-1', 3)).resolves.toBe(0);
    });

    it('rejects zero, negative and fractional quantities before any SQL', async () => {
      await expect(repository.commitReserved('v-1', 0)).rejects.toBeInstanceOf(
        RangeError,
      );
      await expect(repository.commitReserved('v-1', -1)).rejects.toBeInstanceOf(
        RangeError,
      );
      await expect(
        repository.commitReserved('v-1', 1.5),
      ).rejects.toBeInstanceOf(RangeError);
      expect(executeRaw).not.toHaveBeenCalled();
    });

    it('uses the transaction client when one is supplied', async () => {
      const txExecuteRaw = vi.fn().mockResolvedValue(1);

      await expect(
        repository.commitReserved('v-1', 3, {
          $executeRaw: txExecuteRaw,
        } as never),
      ).resolves.toBe(1);
      expect(txExecuteRaw).toHaveBeenCalledTimes(1);
      expect(executeRaw).not.toHaveBeenCalled();
    });
  });

  describe('findStockAlertsPage', () => {
    const buildRow = (
      id: string,
      overrides: { quantity: number; reservedQuantity: number } & Record<string, unknown>,
    ) =>
      ({
        id,
        variantId: `v-${id}`,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        variant: {
          id: `v-${id}`,
          productId: 'p-1',
          sku: 'SKU-1',
          options: [],
          product: { id: 'p-1', name: 'Product 1', images: [] },
        },
        ...overrides,
      }) as unknown as InventoryWithVariant;

    const readQueryRaw = (callIndex = 0) => {
      const [strings, ...values] = queryRaw.mock.calls[callIndex] as [
        TemplateStringsArray,
        ...unknown[],
      ];
      const inline = (value: unknown): string => {
        if (value && typeof value === 'object' && 'strings' in value) {
          return (value as { strings: TemplateStringsArray }).strings.join('');
        }
        return String(value ?? '');
      };
      const sql = strings.reduce((acc, str, i) => acc + str + inline(values[i]), '');
      return { sql, values };
    };

    beforeEach(() => {
      queryRaw.mockReset();
      findMany.mockReset();
    });

    it('in filter returns only available stock greater than 10', async () => {
      queryRaw
        .mockResolvedValueOnce([{ id: 'i-in' }])
        .mockResolvedValueOnce([
          { total: '3', in_stock: '3', low_stock: '0', out_of_stock: '0' },
        ]);
      findMany.mockResolvedValue([
        buildRow('i-in', { quantity: 20, reservedQuantity: 5 }),
      ]);

      const result = await repository.findStockAlertsPage({
        page: 1,
        limit: 10,
        search: undefined,
        status: 'in',
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.quantity - result.items[0]!.reservedQuantity).toBeGreaterThan(10);
      expect(result.inStock).toBe(3);
      expect(result.lowStock).toBe(0);
      expect(result.outOfStock).toBe(0);
      expect(result.total).toBe(3);
      expect(readQueryRaw(0).sql).toMatch(/i\.quantity - i\.reserved_quantity > 10/);
      // Summary uses `all` so every matching record is counted regardless of tab.
      expect(readQueryRaw(1).sql).toMatch(/WHERE TRUE/);
    });

    it('low filter returns available between 1 and 10 inclusive', async () => {
      queryRaw
        .mockResolvedValueOnce([{ id: 'i-low' }])
        .mockResolvedValueOnce([
          { total: '2', in_stock: '1', low_stock: '2', out_of_stock: '0' },
        ]);
      findMany.mockResolvedValue([
        buildRow('i-low', { quantity: 8, reservedQuantity: 2 }),
      ]);

      const result = await repository.findStockAlertsPage({
        page: 1,
        limit: 10,
        search: undefined,
        status: 'low',
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.quantity - result.items[0]!.reservedQuantity).toBe(6);
      expect(result.inStock).toBe(1);
      expect(result.lowStock).toBe(2);
      expect(result.outOfStock).toBe(0);
      expect(result.total).toBe(2);
      expect(readQueryRaw(0).sql).toMatch(/i\.quantity - i\.reserved_quantity BETWEEN 1 AND 10/);
    });

    it('out filter returns available at or below zero', async () => {
      queryRaw
        .mockResolvedValueOnce([{ id: 'i-out' }])
        .mockResolvedValueOnce([
          { total: '1', in_stock: '0', low_stock: '0', out_of_stock: '1' },
        ]);
      findMany.mockResolvedValue([
        buildRow('i-out', { quantity: 4, reservedQuantity: 4 }),
      ]);

      const result = await repository.findStockAlertsPage({
        page: 1,
        limit: 10,
        search: undefined,
        status: 'out',
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.quantity - result.items[0]!.reservedQuantity).toBeLessThanOrEqual(0);
      expect(result.inStock).toBe(0);
      expect(result.lowStock).toBe(0);
      expect(result.outOfStock).toBe(1);
      expect(result.total).toBe(1);
      expect(readQueryRaw(0).sql).toMatch(/i\.quantity - i\.reserved_quantity <= 0/);
    });

    it('alerts filter returns only low and out of stock', async () => {
      queryRaw
        .mockResolvedValueOnce([{ id: 'i-low' }, { id: 'i-out' }])
        .mockResolvedValueOnce([
          { total: '4', in_stock: '1', low_stock: '2', out_of_stock: '1' },
        ]);
      findMany.mockResolvedValue([
        buildRow('i-low', { quantity: 8, reservedQuantity: 2 }),
        buildRow('i-out', { quantity: 3, reservedQuantity: 3 }),
      ]);

      const result = await repository.findStockAlertsPage({
        page: 1,
        limit: 10,
        search: undefined,
        status: 'alerts',
      });

      expect(result.items).toHaveLength(2);
      expect(result.inStock).toBe(1);
      expect(result.lowStock).toBe(2);
      expect(result.outOfStock).toBe(1);
      expect(result.total).toBe(4);
      expect(readQueryRaw(0).sql).toMatch(/i\.quantity - i\.reserved_quantity <= 10/);
      expect(result.items.some((item) => item.quantity - item.reservedQuantity > 10)).toBe(false);
    });

    it('all filter returns every matching variant and counts all statuses', async () => {
      queryRaw
        .mockResolvedValueOnce([{ id: 'i-1' }, { id: 'i-2' }])
        .mockResolvedValueOnce([
          { total: '5', in_stock: '3', low_stock: '1', out_of_stock: '1' },
        ]);
      findMany.mockResolvedValue([
        buildRow('i-1', { quantity: 20, reservedQuantity: 5 }),
        buildRow('i-2', { quantity: 3, reservedQuantity: 0 }),
      ]);

      const result = await repository.findStockAlertsPage({
        page: 1,
        limit: 10,
        search: undefined,
        status: 'all',
      });

      expect(result.items).toHaveLength(2);
      expect(result.inStock).toBe(3);
      expect(result.lowStock).toBe(1);
      expect(result.outOfStock).toBe(1);
      expect(result.total).toBe(5);
      expect(readQueryRaw(0).sql).toMatch(/WHERE TRUE/);
    });

    it('paginates with limit and offset in the ids query', async () => {
      queryRaw
        .mockResolvedValueOnce([{ id: 'i-1' }])
        .mockResolvedValueOnce([
          { total: '25', in_stock: '10', low_stock: '5', out_of_stock: '1' },
        ]);
      findMany.mockResolvedValue([buildRow('i-1', { quantity: 15, reservedQuantity: 3 })]);

      await repository.findStockAlertsPage({
        page: 3,
        limit: 25,
        search: undefined,
        status: 'in',
      });

      expect(readQueryRaw(0).values).toContain(25);
      expect(readQueryRaw(0).values).toContain(50);
      expect(readQueryRaw(0).sql).toMatch(/LIMIT 25 OFFSET 50/);
    });
  });
});
