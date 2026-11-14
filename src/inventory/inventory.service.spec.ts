import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InventoryService } from './inventory.service.js';
import type { InventoryWithVariant } from './repositories/inventory.repository.js';

interface RowInput {
  variantId: string;
  sku: string;
  productName: string;
  image?: string | null;
  options?: Array<{ optionName: string; optionValue: string }>;
  quantity: number;
  reservedQuantity: number;
}

const buildRow = (input: RowInput): InventoryWithVariant =>
  ({
    id: `inventory-${input.variantId}`,
    variantId: input.variantId,
    quantity: input.quantity,
    reservedQuantity: input.reservedQuantity,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    variant: {
      id: input.variantId,
      productId: `product-${input.variantId}`,
      sku: input.sku,
      product: {
        id: `product-${input.variantId}`,
        name: input.productName,
        images:
          input.image === undefined || input.image === null
            ? []
            : [{ imageUrl: input.image }],
      },
      options: input.options ?? [],
    },
  }) as unknown as InventoryWithVariant;

const STOCK_ROWS: RowInput[] = [
  {
    variantId: 'v1',
    sku: 'ALPHA',
    productName: 'Alpha tee',
    quantity: 100,
    reservedQuantity: 0,
  },
  {
    variantId: 'v2',
    sku: 'BETA',
    productName: 'Beta tee',
    quantity: 10,
    reservedQuantity: 0,
  },
  {
    variantId: 'v3',
    sku: 'GAMMA',
    productName: 'Gamma tee',
    quantity: 0,
    reservedQuantity: 0,
  },
  {
    variantId: 'v4',
    sku: 'DELTA',
    productName: 'Delta tee',
    quantity: 12,
    reservedQuantity: 5,
  },
];

describe('InventoryService.findStockAlerts', () => {
  let repository: { findStockAlertsPage: ReturnType<typeof vi.fn> };
  let service: InventoryService;

  beforeEach(() => {
    repository = { findStockAlertsPage: vi.fn() };
    service = new InventoryService(
      repository as never,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  const paginated = (rows: RowInput[], counts: { inStock: number; lowStock: number; outOfStock: number; total: number }) => ({
    items: rows.map(buildRow),
    ...counts,
  });

  it('derives available and status from the counters and counts every row', async () => {
    repository.findStockAlertsPage.mockResolvedValue(
      paginated(STOCK_ROWS, { inStock: 1, lowStock: 2, outOfStock: 1, total: 4 }),
    );

    const result = await service.findStockAlerts({ page: 1, limit: 10 });

    expect(result.summary).toEqual({
      inStock: 1,
      lowStock: 2,
      outOfStock: 1,
      total: 4,
    });

    const bySku = new Map(result.items.map((item) => [item.sku, item]));
    expect(bySku.get('ALPHA')?.available).toBe(100);
    expect(bySku.get('ALPHA')?.status).toBe('IN_STOCK');
    expect(bySku.get('BETA')?.available).toBe(10);
    expect(bySku.get('BETA')?.status).toBe('LOW_STOCK');
    expect(bySku.get('GAMMA')?.available).toBe(0);
    expect(bySku.get('GAMMA')?.status).toBe('OUT_OF_STOCK');
  });

  it('subtracts reserved stock before choosing a status', async () => {
    repository.findStockAlertsPage.mockResolvedValue(
      paginated(STOCK_ROWS, { inStock: 1, lowStock: 2, outOfStock: 1, total: 4 }),
    );

    const result = await service.findStockAlerts({ page: 1, limit: 10 });
    const delta = result.items.find((item) => item.sku === 'DELTA');

    expect(delta?.quantity).toBe(12);
    expect(delta?.reservedQuantity).toBe(5);
    expect(delta?.available).toBe(7);
    expect(delta?.status).toBe('LOW_STOCK');
  });

  it('counts every matching record while the page only shows the filtered rows', async () => {
    repository.findStockAlertsPage.mockResolvedValue(
      paginated(STOCK_ROWS.slice(1, 3), { inStock: 1, lowStock: 2, outOfStock: 1, total: 4 }),
    );

    const result = await service.findStockAlerts({
      page: 1,
      limit: 10,
      status: 'alerts',
    });

    expect(result.summary.total).toBe(4);
    expect(result.items).toHaveLength(2);
    expect(result.pagination.total).toBe(4);
    expect(result.items.some((item) => item.status === 'IN_STOCK')).toBe(false);
  });

  it('passes the status filter to the repository', async () => {
    repository.findStockAlertsPage.mockResolvedValue(
      paginated([STOCK_ROWS[2]], { inStock: 1, lowStock: 2, outOfStock: 1, total: 4 }),
    );

    await service.findStockAlerts({ page: 1, limit: 10, status: 'out' });

    expect(repository.findStockAlertsPage).toHaveBeenCalledWith({
      page: 1,
      limit: 10,
      search: undefined,
      status: 'out',
    });
  });

  it('defaults page to 1 and limit to 10', async () => {
    repository.findStockAlertsPage.mockResolvedValue(
      paginated([], { inStock: 0, lowStock: 0, outOfStock: 0, total: 0 }),
    );

    await service.findStockAlerts({ page: 1, limit: 10 });

    expect(repository.findStockAlertsPage).toHaveBeenCalledWith({
      page: 1,
      limit: 10,
      search: undefined,
      status: 'alerts',
    });
  });

  it('passes the search term to the repository', async () => {
    repository.findStockAlertsPage.mockResolvedValue(
      paginated([], { inStock: 0, lowStock: 0, outOfStock: 0, total: 0 }),
    );

    await service.findStockAlerts({ page: 1, limit: 10, search: 'Alpha' });

    expect(repository.findStockAlertsPage).toHaveBeenCalledWith({
      page: 1,
      limit: 10,
      search: 'Alpha',
      status: 'alerts',
    });
  });

  it('computes totalPages from total and limit', async () => {
    repository.findStockAlertsPage.mockResolvedValue(
      paginated(STOCK_ROWS, { inStock: 1, lowStock: 2, outOfStock: 1, total: 25 }),
    );

    const result = await service.findStockAlerts({ page: 3, limit: 10 });

    expect(result.pagination).toEqual({
      page: 3,
      limit: 10,
      total: 25,
      totalPages: 3,
    });
  });

  it('returns an empty page when nothing matches', async () => {
    repository.findStockAlertsPage.mockResolvedValue({
      items: [],
      total: 0,
      inStock: 0,
      lowStock: 0,
      outOfStock: 0,
    });

    const result = await service.findStockAlerts({ page: 1, limit: 10 });

    expect(result.items).toEqual([]);
    expect(result.summary.total).toBe(0);
    expect(result.pagination.totalPages).toBe(0);
  });

  it('reads colour and size case-insensitively and returns null when absent', async () => {
    repository.findStockAlertsPage.mockResolvedValue(
      paginated(
        [
          { ...STOCK_ROWS[0], image: 'https://cdn.example/alpha.jpg', options: [
            { optionName: 'Color', optionValue: 'Black' },
            { optionName: 'size', optionValue: 'M' },
          ] },
          { ...STOCK_ROWS[1] },
        ],
        { inStock: 1, lowStock: 1, outOfStock: 0, total: 2 },
      ),
    );

    const result = await service.findStockAlerts({ page: 1, limit: 10, status: 'all' });
    const alpha = result.items.find((item) => item.sku === 'ALPHA');
    const beta = result.items.find((item) => item.sku === 'BETA');

    expect(alpha?.productImage).toBe('https://cdn.example/alpha.jpg');
    expect(alpha?.color).toBe('Black');
    expect(alpha?.size).toBe('M');
    expect(beta?.productImage).toBeNull();
    expect(beta?.color).toBeNull();
    expect(beta?.size).toBeNull();
  });

  it('preserves the repository order (severity, then smallest available)', async () => {
    repository.findStockAlertsPage.mockResolvedValue(
      paginated([STOCK_ROWS[2], STOCK_ROWS[3], STOCK_ROWS[1]], {
        inStock: 1,
        lowStock: 2,
        outOfStock: 1,
        total: 4,
      }),
    );

    const result = await service.findStockAlerts({ page: 1, limit: 10 });

    expect(result.items.map((item) => item.sku)).toEqual(['GAMMA', 'DELTA', 'BETA']);
  });
});
