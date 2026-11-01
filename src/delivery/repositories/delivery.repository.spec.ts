import { Test, TestingModule } from '@nestjs/testing';
import type { Mock } from 'vitest';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  DeliveryRepository,
  type CodReconciliationFilters,
} from './delivery.repository.js';

function extractAllFromCall(callArgs: any[]): {
  fullSql: string;
  allValues: any[];
} {
  const allValues: any[] = [];

  function stringifySql(strings: readonly string[], values: any[]): string {
    let result = '';
    for (let i = 0; i < strings.length; i++) {
      result += strings[i];
      if (i < values.length) {
        const val = values[i];
        if (val && typeof val === 'object' && Array.isArray(val.strings)) {
          result += stringifySql(val.strings, val.values ?? []);
        } else {
          allValues.push(val);
          result += `$param`;
        }
      }
    }
    return result;
  }

  const fullSql = stringifySql(callArgs[0], callArgs.slice(1));
  return { fullSql, allValues };
}

describe('DeliveryRepository — COD Financial Reconciliation', () => {
  let repository: DeliveryRepository;
  let prisma: {
    $queryRaw: Mock;
    $transaction: Mock;
    order: {
      findUnique: Mock;
      findMany: Mock;
      count: Mock;
    };
    user: {
      findUnique: Mock;
      findMany: Mock;
    };
    codCollection: {
      findMany: Mock;
      count: Mock;
      groupBy: Mock;
      aggregate: Mock;
    };
    deliveryAssignment: {
      findMany: Mock;
      count: Mock;
    };
  };

  const STAFF_A = '11111111-1111-4111-8111-111111111111';
  const STAFF_B = '22222222-2222-4222-8222-222222222222';
  const ORDER_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const ORDER_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('lists only active delivery staff with the public assignment fields', async () => {
    await repository.findActiveDeliveryStaff();

    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { role: 'DELIVERY_STAFF', status: 'ACTIVE' },
      select: { id: true, firstName: true, lastName: true, email: true },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }, { id: 'asc' }],
    });
  });

  beforeEach(async () => {
    prisma = {
      $queryRaw: vi.fn(),
      $transaction: vi.fn(),
      order: {
        findUnique: vi.fn(),
        findMany: vi.fn(),
        count: vi.fn(),
      },
      user: {
        findUnique: vi.fn(),
        findMany: vi.fn().mockResolvedValue([
          {
            id: STAFF_A,
            firstName: 'Alice',
            lastName: 'Courier',
            email: 'alice@example.test',
          },
          {
            id: STAFF_B,
            firstName: 'Bob',
            lastName: 'Collector',
            email: 'bob@example.test',
          },
        ]),
      },
      codCollection: {
        findMany: vi.fn(),
        count: vi.fn(),
        groupBy: vi.fn(),
        aggregate: vi.fn(),
      },
      deliveryAssignment: {
        findMany: vi.fn(),
        count: vi.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeliveryRepository,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    repository = module.get(DeliveryRepository);
  });

  describe('findCodReconciliationRecords', () => {
    it('1. Delivered COD order with valid collection (discrepancy = false)', async () => {
      // Return count first, then data row
      prisma.$queryRaw
        .mockResolvedValueOnce([{ count: 1 }])
        .mockResolvedValueOnce([
          {
            order_id: ORDER_1,
            order_number: 'ORD-001',
            order_status: 'DELIVERED',
            payment_method: 'COD',
            total_amount: new Prisma.Decimal('50.00'),
            currency: 'USD',
            delivery_date: new Date('2026-10-15T10:00:00Z'),
            delivery_staff_id: STAFF_A,
            delivered_at: new Date('2026-10-15T10:00:00Z'),
            collection_id: 'col-001',
            collected_amount: new Prisma.Decimal('50.00'),
            collection_currency: 'USD',
            collected_at: new Date('2026-10-15T10:05:00Z'),
            collected_by_id: STAFF_A,
            collector_first_name: 'Alice',
            collector_last_name: 'Courier',
            collector_email: 'alice@example.test',
            delivery_first_name: 'Alice',
            delivery_last_name: 'Courier',
            delivery_email: 'alice@example.test',
            discrepancy_type: null,
          },
        ]);

      const result = await repository.findCodReconciliationRecords({});

      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(1);
      const item = result.items[0];
      expect(item.orderId).toBe(ORDER_1);
      expect(item.expectedAmount.equals(new Prisma.Decimal('50.00'))).toBe(
        true,
      );
      expect(item.collectedAmount?.equals(new Prisma.Decimal('50.00'))).toBe(
        true,
      );
      expect(item.discrepancy).toBe(false);
      expect(item.discrepancyType).toBeNull();
      expect(item.collectedBy?.firstName).toBe('Alice');
      expect(item.deliveryStaff?.firstName).toBe('Alice');
    });

    it('2. Delivered COD order without collection (discrepancy = true, missing-collection)', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([{ count: 1 }])
        .mockResolvedValueOnce([
          {
            order_id: ORDER_2,
            order_number: 'ORD-002',
            order_status: 'DELIVERED',
            payment_method: 'COD',
            total_amount: new Prisma.Decimal('75.00'),
            currency: 'USD',
            delivery_date: new Date('2026-10-16T12:00:00Z'),
            delivery_staff_id: STAFF_A,
            delivered_at: new Date('2026-10-16T12:00:00Z'),
            collection_id: null,
            collected_amount: null,
            collection_currency: null,
            collected_at: null,
            collected_by_id: null,
            collector_first_name: null,
            collector_last_name: null,
            collector_email: null,
            delivery_first_name: 'Alice',
            delivery_last_name: 'Courier',
            delivery_email: 'alice@example.test',
            discrepancy_type: 'missing-collection',
          },
        ]);

      const result = await repository.findCodReconciliationRecords({});

      expect(result.total).toBe(1);
      const item = result.items[0];
      expect(item.collectedAmount).toBeNull();
      expect(item.discrepancy).toBe(true);
      expect(item.discrepancyType).toBe('missing-collection');
      expect(item.collectedBy).toBeNull();
      expect(item.deliveryStaff?.id).toBe(STAFF_A);
    });

    it('3. Amount mismatch detected', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([{ count: 1 }])
        .mockResolvedValueOnce([
          {
            order_id: ORDER_1,
            order_number: 'ORD-003',
            order_status: 'DELIVERED',
            payment_method: 'COD',
            total_amount: new Prisma.Decimal('100.00'),
            currency: 'USD',
            delivery_date: new Date('2026-10-15T10:00:00Z'),
            delivery_staff_id: STAFF_A,
            delivered_at: new Date('2026-10-15T10:00:00Z'),
            collection_id: 'col-003',
            collected_amount: new Prisma.Decimal('80.00'),
            collection_currency: 'USD',
            collected_at: new Date('2026-10-15T10:05:00Z'),
            collected_by_id: STAFF_A,
            collector_first_name: 'Alice',
            collector_last_name: 'Courier',
            collector_email: 'alice@example.test',
            delivery_first_name: 'Alice',
            delivery_last_name: 'Courier',
            delivery_email: 'alice@example.test',
            discrepancy_type: 'amount-mismatch',
          },
        ]);

      const result = await repository.findCodReconciliationRecords({});
      expect(result.items[0].discrepancy).toBe(true);
      expect(result.items[0].discrepancyType).toBe('amount-mismatch');
      expect(
        result.items[0].totalAmount.equals(new Prisma.Decimal('100.00')),
      ).toBe(true);
      expect(
        result.items[0].collectedAmount?.equals(new Prisma.Decimal('80.00')),
      ).toBe(true);
    });

    it('4. Currency mismatch detected and currencies reported separately', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([{ count: 1 }])
        .mockResolvedValueOnce([
          {
            order_id: ORDER_1,
            order_number: 'ORD-004',
            order_status: 'DELIVERED',
            payment_method: 'COD',
            total_amount: new Prisma.Decimal('50.00'),
            currency: 'USD',
            delivery_staff_id: STAFF_A,
            delivered_at: new Date('2026-10-15T10:00:00Z'),
            collection_id: 'col-004',
            collected_amount: new Prisma.Decimal('200000.00'),
            collection_currency: 'KHR',
            collected_at: new Date('2026-10-15T10:05:00Z'),
            collected_by_id: STAFF_A,
            collector_first_name: 'Alice',
            collector_last_name: 'Courier',
            collector_email: 'alice@example.test',
            delivery_first_name: 'Alice',
            delivery_last_name: 'Courier',
            delivery_email: 'alice@example.test',
            discrepancy_type: 'currency-mismatch',
          },
        ]);

      const result = await repository.findCodReconciliationRecords({});
      expect(result.items[0].discrepancy).toBe(true);
      expect(result.items[0].discrepancyType).toBe('currency-mismatch');
      expect(result.items[0].currency).toBe('USD');
      expect(result.items[0].collectionCurrency).toBe('KHR');
      expect(
        result.items[0].expectedAmount.equals(new Prisma.Decimal('50.00')),
      ).toBe(true);
      expect(
        result.items[0].collectedAmount?.equals(
          new Prisma.Decimal('200000.00'),
        ),
      ).toBe(true);
    });

    it('4b. Delivered order with delivered_at IS NULL does not invent delivery date', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([{ count: 1 }])
        .mockResolvedValueOnce([
          {
            order_id: ORDER_1,
            order_number: 'ORD-NULL-DATE',
            order_status: 'DELIVERED',
            payment_method: 'COD',
            total_amount: new Prisma.Decimal('50.00'),
            currency: 'USD',
            delivery_staff_id: null,
            delivered_at: null,
            collection_id: null,
            collected_amount: null,
            collection_currency: null,
            collected_at: null,
            collected_by_id: null,
            collector_first_name: null,
            collector_last_name: null,
            collector_email: null,
            delivery_first_name: null,
            delivery_last_name: null,
            delivery_email: null,
            discrepancy_type: 'missing-collection',
          },
        ]);

      const result = await repository.findCodReconciliationRecords({});
      expect(result.items[0].deliveredAt).toBeNull();
    });

    it('5. COD order without Payment record is NOT a discrepancy when collection matches', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([{ count: 1 }])
        .mockResolvedValueOnce([
          {
            order_id: ORDER_1,
            order_number: 'ORD-005',
            order_status: 'DELIVERED',
            payment_method: 'COD',
            total_amount: new Prisma.Decimal('50.00'),
            currency: 'USD',
            delivery_date: new Date('2026-10-15T10:00:00Z'),
            delivery_staff_id: STAFF_A,
            delivered_at: new Date('2026-10-15T10:00:00Z'),
            collection_id: 'col-005',
            collected_amount: new Prisma.Decimal('50.00'),
            collection_currency: 'USD',
            collected_at: new Date('2026-10-15T10:05:00Z'),
            collected_by_id: STAFF_A,
            collector_first_name: 'Alice',
            collector_last_name: 'Courier',
            collector_email: 'alice@example.test',
            delivery_first_name: 'Alice',
            delivery_last_name: 'Courier',
            delivery_email: 'alice@example.test',
            discrepancy_type: null,
          },
        ]);

      const result = await repository.findCodReconciliationRecords({});
      expect(result.items[0].discrepancy).toBe(false);
      expect(result.items[0].discrepancyType).toBeNull();
    });

    it('6. Multiple delivery assignments deduplicated in CTE', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([{ count: 1 }])
        .mockResolvedValueOnce([
          {
            order_id: ORDER_1,
            order_number: 'ORD-006',
            order_status: 'DELIVERED',
            payment_method: 'COD',
            total_amount: new Prisma.Decimal('50.00'),
            currency: 'USD',
            delivery_date: new Date('2026-10-16T10:00:00Z'),
            delivery_staff_id: STAFF_B,
            delivered_at: new Date('2026-10-16T10:00:00Z'),
            collection_id: 'col-006',
            collected_amount: new Prisma.Decimal('50.00'),
            collection_currency: 'USD',
            collected_at: new Date('2026-10-16T10:05:00Z'),
            collected_by_id: STAFF_B,
            collector_first_name: 'Bob',
            collector_last_name: 'Collector',
            collector_email: 'bob@example.test',
            delivery_first_name: 'Bob',
            delivery_last_name: 'Collector',
            delivery_email: 'bob@example.test',
            discrepancy_type: null,
          },
        ]);

      const result = await repository.findCodReconciliationRecords({});
      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].deliveryStaffId).toBe(STAFF_B);

      // Verify the CTE SQL includes DISTINCT ON for deduplication
      const queryCall = prisma.$queryRaw.mock.calls[0][0] as Prisma.Sql;
      const sqlText = queryCall.text ?? JSON.stringify(queryCall);
      expect(sqlText).toContain('DISTINCT ON');
    });

    it('7. Multiple currencies separation', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([{ count: 2 }])
        .mockResolvedValueOnce([
          {
            order_id: ORDER_1,
            order_number: 'ORD-USD',
            order_status: 'DELIVERED',
            payment_method: 'COD',
            total_amount: new Prisma.Decimal('50.00'),
            currency: 'USD',
            delivery_date: new Date('2026-10-15T10:00:00Z'),
            delivery_staff_id: STAFF_A,
            delivered_at: new Date('2026-10-15T10:00:00Z'),
            collection_id: 'col-usd',
            collected_amount: new Prisma.Decimal('50.00'),
            collection_currency: 'USD',
            collected_at: new Date('2026-10-15T10:05:00Z'),
            collected_by_id: STAFF_A,
            collector_first_name: 'Alice',
            collector_last_name: 'Courier',
            collector_email: 'alice@example.test',
            delivery_first_name: 'Alice',
            delivery_last_name: 'Courier',
            delivery_email: 'alice@example.test',
            discrepancy_type: null,
          },
          {
            order_id: ORDER_2,
            order_number: 'ORD-KHR',
            order_status: 'DELIVERED',
            payment_method: 'COD',
            total_amount: new Prisma.Decimal('200000.00'),
            currency: 'KHR',
            delivery_date: new Date('2026-10-15T11:00:00Z'),
            delivery_staff_id: STAFF_A,
            delivered_at: new Date('2026-10-15T11:00:00Z'),
            collection_id: 'col-khr',
            collected_amount: new Prisma.Decimal('200000.00'),
            collection_currency: 'KHR',
            collected_at: new Date('2026-10-15T11:05:00Z'),
            collected_by_id: STAFF_A,
            collector_first_name: 'Alice',
            collector_last_name: 'Courier',
            collector_email: 'alice@example.test',
            delivery_first_name: 'Alice',
            delivery_last_name: 'Courier',
            delivery_email: 'alice@example.test',
            discrepancy_type: null,
          },
        ]);

      const result = await repository.findCodReconciliationRecords({});
      expect(result.items).toHaveLength(2);
      expect(result.items[0].currency).toBe('USD');
      expect(result.items[1].currency).toBe('KHR');
    });

    it('8. Date boundary filtering uses order delivery date', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([{ count: 0 }])
        .mockResolvedValueOnce([]);

      const filters: CodReconciliationFilters = {
        startDate: new Date('2026-10-01T00:00:00Z'),
        endDate: new Date('2026-10-31T23:59:59Z'),
      };
      await repository.findCodReconciliationRecords(filters);

      const queryCall = prisma.$queryRaw.mock.calls[0][0] as Prisma.Sql;
      const sqlText = queryCall.text ?? JSON.stringify(queryCall);
      expect(sqlText).toContain('delivered_at');
    });

    it('9. Empty dataset returns zero counts and empty items', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([{ count: 0 }])
        .mockResolvedValueOnce([]);

      const result = await repository.findCodReconciliationRecords({
        page: 1,
        limit: 20,
      });
      expect(result.total).toBe(0);
      expect(result.items).toEqual([]);
      expect(result.totalPages).toBe(0);
    });

    it('10. Deterministic pagination', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([{ count: 10 }])
        .mockResolvedValueOnce([]);

      const result = await repository.findCodReconciliationRecords({
        page: 2,
        limit: 5,
        sortBy: 'collectedAt',
        sortOrder: 'desc',
      });

      expect(result.page).toBe(2);
      expect(result.limit).toBe(5);
      expect(result.totalPages).toBe(2);

      const { fullSql } = extractAllFromCall(prisma.$queryRaw.mock.calls[1]);
      expect(fullSql).toContain('LIMIT');
      expect(fullSql).toContain('OFFSET');
      expect(fullSql).toContain('order_id DESC');
    });

    it('11. Staff attribution: collector and delivery staff distinct', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([{ count: 1 }])
        .mockResolvedValueOnce([
          {
            order_id: ORDER_1,
            order_number: 'ORD-011',
            order_status: 'DELIVERED',
            payment_method: 'COD',
            total_amount: new Prisma.Decimal('50.00'),
            currency: 'USD',
            delivery_date: new Date('2026-10-15T10:00:00Z'),
            delivery_staff_id: STAFF_A,
            delivered_at: new Date('2026-10-15T10:00:00Z'),
            collection_id: 'col-011',
            collected_amount: new Prisma.Decimal('50.00'),
            collection_currency: 'USD',
            collected_at: new Date('2026-10-15T10:05:00Z'),
            collected_by_id: STAFF_B,
            collector_first_name: 'Bob',
            collector_last_name: 'Collector',
            collector_email: 'bob@example.test',
            delivery_first_name: 'Alice',
            delivery_last_name: 'Courier',
            delivery_email: 'alice@example.test',
            discrepancy_type: null,
          },
        ]);

      const result = await repository.findCodReconciliationRecords({});
      expect(result.items[0].deliveryStaffId).toBe(STAFF_A);
      expect(result.items[0].deliveryStaff?.firstName).toBe('Alice');
      expect(result.items[0].collectedById).toBe(STAFF_B);
      expect(result.items[0].collectedBy?.firstName).toBe('Bob');
    });

    it('12. No double counting of orders', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([{ count: 1 }])
        .mockResolvedValueOnce([
          {
            order_id: ORDER_1,
            order_number: 'ORD-012',
            order_status: 'DELIVERED',
            payment_method: 'COD',
            total_amount: new Prisma.Decimal('50.00'),
            currency: 'USD',
            delivery_date: new Date('2026-10-15T10:00:00Z'),
            delivery_staff_id: STAFF_A,
            delivered_at: new Date('2026-10-15T10:00:00Z'),
            collection_id: 'col-012',
            collected_amount: new Prisma.Decimal('50.00'),
            collection_currency: 'USD',
            collected_at: new Date('2026-10-15T10:05:00Z'),
            collected_by_id: STAFF_A,
            collector_first_name: 'Alice',
            collector_last_name: 'Courier',
            collector_email: 'alice@example.test',
            delivery_first_name: 'Alice',
            delivery_last_name: 'Courier',
            delivery_email: 'alice@example.test',
            discrepancy_type: null,
          },
        ]);

      const result = await repository.findCodReconciliationRecords({});
      expect(result.total).toBe(1);
    });

    it('13. SQL parameterization: inputs passed as parameters', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([{ count: 0 }])
        .mockResolvedValueOnce([]);

      await repository.findCodReconciliationRecords({
        orderNumber: 'ORD-TEST',
        currency: 'USD',
        staffId: STAFF_A,
      });

      const { allValues } = extractAllFromCall(prisma.$queryRaw.mock.calls[0]);
      expect(allValues).toContain('USD');
      expect(allValues).toContain('%ORD-TEST%');
      expect(allValues).toContain(STAFF_A);
    });
  });

  describe('summarizeCodReconciliation', () => {
    it('aggregates collections, expected and outstanding amounts grouped by currency', async () => {
      // currencyRows, aggRows, periodBreakdown (from period query), staffBreakdown (from staff query)
      prisma.$queryRaw
        .mockResolvedValueOnce([
          {
            currency: 'USD',
            expected_amount: new Prisma.Decimal('150.00'),
            collected_amount: new Prisma.Decimal('100.00'),
            outstanding_amount: new Prisma.Decimal('50.00'),
            count: 2,
          },
        ])
        .mockResolvedValueOnce([
          {
            total_collections: 2,
            discrepancy_count: 1,
            first_collection_at: new Date('2026-10-01T10:00:00Z'),
            last_collection_at: new Date('2026-10-15T15:00:00Z'),
          },
        ])
        // For summarizeCodReconciliationByPeriod:
        .mockResolvedValueOnce([
          {
            period: '2026-10-15',
            currency: 'USD',
            expected_amount: new Prisma.Decimal('150.00'),
            collected_amount: new Prisma.Decimal('100.00'),
            outstanding_amount: new Prisma.Decimal('50.00'),
            count: 2,
          },
        ])
        // For summarizeCodReconciliationByStaff:
        .mockResolvedValueOnce([
          {
            staff_id: STAFF_A,
            currency: 'USD',
            expected_amount: new Prisma.Decimal('150.00'),
            collected_amount: new Prisma.Decimal('100.00'),
            outstanding_amount: new Prisma.Decimal('50.00'),
            count: 2,
          },
        ]);

      const summary = await repository.summarizeCodReconciliation({});

      expect(summary.totalCollections).toBe(2);
      expect(summary.collectionCount).toBe(2);
      expect(summary.discrepancyCount).toBe(1);
      expect(summary.totalsByCurrency).toHaveLength(1);
      expect(summary.totalsByCurrency[0].currency).toBe('USD');
      expect(
        summary.totalsByCurrency[0].expectedAmount.equals(
          new Prisma.Decimal('150.00'),
        ),
      ).toBe(true);
      expect(
        summary.totalsByCurrency[0].collectedAmount.equals(
          new Prisma.Decimal('100.00'),
        ),
      ).toBe(true);
      expect(
        summary.totalsByCurrency[0].outstandingAmount.equals(
          new Prisma.Decimal('50.00'),
        ),
      ).toBe(true);
      expect(summary.firstCollectionAt).toEqual(
        new Date('2026-10-01T10:00:00Z'),
      );
      expect(summary.lastCollectionAt).toEqual(
        new Date('2026-10-15T15:00:00Z'),
      );
      expect(
        summary.expectedAmountByCurrency[0].totalAmount.equals(
          new Prisma.Decimal('150.00'),
        ),
      ).toBe(true);
      expect(
        summary.outstandingAmountByCurrency[0].totalAmount.equals(
          new Prisma.Decimal('50.00'),
        ),
      ).toBe(true);
      expect(summary.periodBreakdown).toHaveLength(1);
      expect(summary.staffBreakdown).toHaveLength(1);
    });
  });

  describe('findUncollectedDeliveredCodOrders', () => {
    it('returns DELIVERED COD orders without CodCollection', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([{ count: 1 }])
        .mockResolvedValueOnce([
          {
            order_id: ORDER_1,
            order_number: 'ORD-UNCOLLECTED',
            order_status: 'DELIVERED',
            total_amount: new Prisma.Decimal('60.00'),
            currency: 'USD',
            delivery_date: new Date('2026-10-20T10:00:00Z'),
            delivery_staff_id: STAFF_A,
            delivered_at: new Date('2026-10-20T10:00:00Z'),
            staff_first_name: 'Alice',
            staff_last_name: 'Courier',
            staff_email: 'alice@example.test',
          },
        ]);

      const result = await repository.findUncollectedDeliveredCodOrders({});

      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(1);
      expect(
        result.items[0].expectedAmount.equals(new Prisma.Decimal('60.00')),
      ).toBe(true);
      expect(result.items[0].deliveryStaff?.id).toBe(STAFF_A);
      expect(result.items[0].deliveredAt).toEqual(
        new Date('2026-10-20T10:00:00Z'),
      );
    });
  });

  describe('findCodReconciliationDiscrepancies', () => {
    it('detects missing collection, amount mismatch, and currency mismatch', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([{ count: 2 }])
        .mockResolvedValueOnce([
          {
            order_id: ORDER_1,
            order_number: 'ORD-DISC-1',
            order_status: 'DELIVERED',
            total_amount: new Prisma.Decimal('50.00'),
            collected_amount: null,
            currency: 'USD',
            collection_id: null,
            discrepancy_type: 'missing-collection',
          },
          {
            order_id: ORDER_2,
            order_number: 'ORD-DISC-2',
            order_status: 'DELIVERED',
            total_amount: new Prisma.Decimal('100.00'),
            collected_amount: new Prisma.Decimal('90.00'),
            currency: 'USD',
            collection_id: 'col-90',
            discrepancy_type: 'amount-mismatch',
          },
        ]);

      const result = await repository.findCodReconciliationDiscrepancies({});

      expect(result.total).toBe(2);
      expect(result.items).toHaveLength(2);
      expect(result.items[0].discrepancyType).toBe('missing-collection');
      expect(result.items[1].discrepancyType).toBe('amount-mismatch');
      expect(
        result.items[1].actualAmount?.equals(new Prisma.Decimal('90.00')),
      ).toBe(true);
    });
  });

  describe('summarizeCodReconciliationByStaff', () => {
    it('groups by staff and currency, attributing collected to collector and outstanding to delivery courier', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([
        {
          staff_id: STAFF_A,
          currency: 'USD',
          expected_amount: new Prisma.Decimal('200.00'),
          collected_amount: new Prisma.Decimal('150.00'),
          outstanding_amount: new Prisma.Decimal('50.00'),
          count: 2,
        },
      ]);

      const result = await repository.summarizeCodReconciliationByStaff({});

      expect(result).toHaveLength(1);
      expect(result[0].staffId).toBe(STAFF_A);
      expect(result[0].staff.firstName).toBe('Alice');
      expect(
        result[0].expectedAmount.equals(new Prisma.Decimal('200.00')),
      ).toBe(true);
      expect(
        result[0].collectedAmount.equals(new Prisma.Decimal('150.00')),
      ).toBe(true);
      expect(
        result[0].outstandingAmount.equals(new Prisma.Decimal('50.00')),
      ).toBe(true);
      expect(result[0].count).toBe(2);
    });
  });

  describe('summarizeCodReconciliationByPeriod', () => {
    it('14. Daily, weekly and monthly aggregation in UTC boundaries', async () => {
      // Daily
      prisma.$queryRaw.mockResolvedValueOnce([
        {
          period: '2026-10-15',
          currency: 'USD',
          expected_amount: new Prisma.Decimal('100.00'),
          collected_amount: new Prisma.Decimal('100.00'),
          outstanding_amount: new Prisma.Decimal('0.00'),
          count: 1,
        },
      ]);

      const daily = await repository.summarizeCodReconciliationByPeriod({
        period: 'daily',
      });
      expect(daily[0].period).toBe('2026-10-15');
      const { fullSql: dailySqlText } = extractAllFromCall(
        prisma.$queryRaw.mock.calls[0],
      );
      expect(dailySqlText).toContain(
        'to_char(lda."delivered_at" AT TIME ZONE \'UTC\'',
      );

      // Weekly
      prisma.$queryRaw.mockResolvedValueOnce([
        {
          period: '2026-10-12',
          currency: 'USD',
          expected_amount: new Prisma.Decimal('500.00'),
          collected_amount: new Prisma.Decimal('450.00'),
          outstanding_amount: new Prisma.Decimal('50.00'),
          count: 5,
        },
      ]);

      const weekly = await repository.summarizeCodReconciliationByPeriod({
        period: 'weekly',
      });
      expect(weekly[0].period).toBe('2026-10-12');
      const { fullSql: weeklySqlText } = extractAllFromCall(
        prisma.$queryRaw.mock.calls[1],
      );
      expect(weeklySqlText).toContain("date_trunc('week'");

      // Monthly
      prisma.$queryRaw.mockResolvedValueOnce([
        {
          period: '2026-10',
          currency: 'USD',
          expected_amount: new Prisma.Decimal('2000.00'),
          collected_amount: new Prisma.Decimal('1900.00'),
          outstanding_amount: new Prisma.Decimal('100.00'),
          count: 20,
        },
      ]);

      const monthly = await repository.summarizeCodReconciliationByPeriod({
        period: 'monthly',
      });
      expect(monthly[0].period).toBe('2026-10');
      const { fullSql: monthlySqlText } = extractAllFromCall(
        prisma.$queryRaw.mock.calls[2],
      );
      expect(monthlySqlText).toContain("date_trunc('month'");
    });

    it('15. Currency mismatch in period aggregation reports expected under order currency and collected under collection currency', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([
        {
          period: '2026-10-15',
          currency: 'USD',
          expected_amount: new Prisma.Decimal('100.00'),
          collected_amount: new Prisma.Decimal('0.00'),
          outstanding_amount: new Prisma.Decimal('100.00'),
          count: 0,
        },
        {
          period: '2026-10-15',
          currency: 'KHR',
          expected_amount: new Prisma.Decimal('0.00'),
          collected_amount: new Prisma.Decimal('400000.00'),
          outstanding_amount: new Prisma.Decimal('0.00'),
          count: 1,
        },
      ]);

      const result = await repository.summarizeCodReconciliationByPeriod({
        period: 'daily',
      });
      expect(result).toHaveLength(2);
      expect(result[0].currency).toBe('USD');
      expect(
        result[0].expectedAmount.equals(new Prisma.Decimal('100.00')),
      ).toBe(true);
      expect(result[0].collectedAmount.equals(new Prisma.Decimal('0.00'))).toBe(
        true,
      );
      expect(
        result[0].outstandingAmount.equals(new Prisma.Decimal('100.00')),
      ).toBe(true);

      expect(result[1].currency).toBe('KHR');
      expect(result[1].expectedAmount.equals(new Prisma.Decimal('0.00'))).toBe(
        true,
      );
      expect(
        result[1].collectedAmount.equals(new Prisma.Decimal('400000.00')),
      ).toBe(true);
      expect(
        result[1].outstandingAmount.equals(new Prisma.Decimal('0.00')),
      ).toBe(true);
    });
  });
});
