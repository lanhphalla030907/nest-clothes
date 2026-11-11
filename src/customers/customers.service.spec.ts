import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import type {
  AdminCustomerRow,
  CustomerAddressRow,
  CustomerRecentOrderRow,
} from './customers.repository.js';
import { CustomersRepository } from './customers.repository.js';
import { CustomersService } from './customers.service.js';
import { AdminCustomerListQueryDto } from './dto/admin-customer-list-query.dto.js';

/**
 * Service-level customer rules with the SQL repository stubbed out.
 *
 * The repository spec pins the aggregation; these tests prove how the service
 * resolves defaults, enforces the cross-field date rule, anchors the "new
 * customer" window, and maps rows to the response contract: money is a
 * string, currencies stay separate, and an unavailable figure is absent rather
 * than invented.
 */

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';

function customerRow(
  overrides: Partial<AdminCustomerRow> = {},
): AdminCustomerRow {
  return {
    id: CUSTOMER_ID,
    first_name: 'Spend',
    last_name: 'Tester',
    email: 'spend@example.test',
    phone: '+15555550100',
    status: 'ACTIVE',
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-02T00:00:00.000Z'),
    email_verified_at: null,
    last_login_at: null,
    total_orders: 7,
    cancelled_orders: 1,
    spending_orders: 4,
    last_order_at: new Date('2026-02-01T00:00:00.000Z'),
    total_spent_by_currency: [
      { currency: 'USD', amount: '180.00', orderCount: 3 },
      { currency: 'KHR', amount: '400000.00', orderCount: 1 },
    ],
    ...overrides,
  };
}

function recentOrder(
  overrides: Partial<CustomerRecentOrderRow> = {},
): CustomerRecentOrderRow {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    orderNumber: 'ORD-20260104-AAAAAA',
    status: 'PENDING',
    paymentMethod: 'ABA_PAYWAY',
    totalAmount: new Prisma.Decimal('128.50'),
    currency: 'USD',
    createdAt: new Date('2026-01-04T11:30:00.000Z'),
    items: [{ quantity: 2 }, { quantity: 1 }],
    payments: [],
    codCollections: [],
    ...overrides,
  };
}

function addressRow(
  overrides: Partial<CustomerAddressRow> = {},
): CustomerAddressRow {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    label: 'Home',
    recipientName: 'Spend Tester',
    phone: '+15555550100',
    addressLine1: 'Street 123',
    addressLine2: null,
    city: 'Phnom Penh',
    stateProvince: null,
    administrativeLocationPcode: '120101',
    postalCode: null,
    countryCode: 'KH',
    isDefault: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function makeRepository() {
  return {
    findAdminPage: vi.fn(),
    findAdminCustomerById: vi.fn(),
    findRecentOrders: vi.fn(),
    findAddresses: vi.fn(),
    getStats: vi.fn(),
  };
}

function makeService(repository: ReturnType<typeof makeRepository>) {
  return new CustomersService(repository as unknown as CustomersRepository);
}

function query(overrides: Partial<AdminCustomerListQueryDto> = {}) {
  // A DTO built by hand carries the class initialisers — page 1, limit 20 —
  // exactly the way the ValidationPipe transform would deliver a request with
  // no pagination parameters.
  return Object.assign(new AdminCustomerListQueryDto(), overrides);
}

describe('CustomersService', () => {
  let repository: ReturnType<typeof makeRepository>;
  let service: CustomersService;

  beforeEach(() => {
    repository = makeRepository();
    service = makeService(repository);
  });

  describe('listCustomers', () => {
    it('resolves the documented defaults and maps the page to the response', async () => {
      repository.findAdminPage.mockResolvedValue({
        items: [customerRow()],
        total: 41,
      });

      const result = await service.listCustomers(query());

      expect(repository.findAdminPage).toHaveBeenCalledWith({
        page: 1,
        limit: 20,
        search: undefined,
        status: undefined,
        registeredFrom: undefined,
        registeredTo: undefined,
        orderActivity: undefined,
        sortBy: 'createdAt',
        sortOrder: 'desc',
      });
      expect(result.pagination).toEqual({
        page: 1,
        limit: 20,
        total: 41,
        totalPages: 3,
      });
      expect(result.items[0]).toMatchObject({
        id: CUSTOMER_ID,
        firstName: 'Spend',
        lastName: 'Tester',
        email: 'spend@example.test',
        phone: '+15555550100',
        status: 'ACTIVE',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        totalOrders: 7,
        totalSpentByCurrency: [
          { currency: 'USD', amount: '180.00' },
          { currency: 'KHR', amount: '400000.00' },
        ],
        lastOrderAt: new Date('2026-02-01T00:00:00.000Z'),
      });
    });

    it('passes explicit filters and sorts through to the repository', async () => {
      repository.findAdminPage.mockResolvedValue({ items: [], total: 0 });

      await service.listCustomers(
        query({
          page: 2,
          limit: 50,
          status: 'ACTIVE',
          orderActivity: 'WITH_ORDERS',
          sortBy: 'totalSpent',
          sortOrder: 'asc',
        }),
      );

      expect(repository.findAdminPage).toHaveBeenCalledWith(
        expect.objectContaining({
          page: 2,
          limit: 50,
          status: 'ACTIVE',
          orderActivity: 'WITH_ORDERS',
          sortBy: 'totalSpent',
          sortOrder: 'asc',
        }),
      );
    });

    it('trims a search term before it reaches the repository', async () => {
      repository.findAdminPage.mockResolvedValue({ items: [], total: 0 });

      await service.listCustomers(query({ search: '  Ada  ' }));

      expect(repository.findAdminPage).toHaveBeenCalledWith(
        expect.objectContaining({ search: 'Ada' }),
      );
    });

    it('drops a blank search instead of matching whitespace', async () => {
      repository.findAdminPage.mockResolvedValue({ items: [], total: 0 });

      await service.listCustomers(query({ search: '   ' }));

      expect(repository.findAdminPage).toHaveBeenCalledWith(
        expect.objectContaining({ search: undefined }),
      );
    });

    it('parses both date bounds into Dates and keeps them inclusive', async () => {
      repository.findAdminPage.mockResolvedValue({ items: [], total: 0 });

      await service.listCustomers(
        query({
          registeredFrom: '2026-01-01T00:00:00.000Z',
          registeredTo: '2026-01-01T00:00:00.000Z',
        }),
      );

      expect(repository.findAdminPage).toHaveBeenCalledWith(
        expect.objectContaining({
          registeredFrom: new Date('2026-01-01T00:00:00.000Z'),
          registeredTo: new Date('2026-01-01T00:00:00.000Z'),
        }),
      );
    });

    it('refuses registeredFrom later than registeredTo with a 400', async () => {
      await expect(
        service.listCustomers(
          query({
            registeredFrom: '2026-02-01T00:00:00.000Z',
            registeredTo: '2026-01-01T00:00:00.000Z',
          }),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(repository.findAdminPage).not.toHaveBeenCalled();
    });

    it('refuses a timestamp the DTO would already have rejected, in case a caller bypasses HTTP', async () => {
      await expect(
        service.listCustomers(query({ registeredFrom: 'not-a-date' })),
      ).rejects.toThrow(BadRequestException);
      expect(repository.findAdminPage).not.toHaveBeenCalled();
    });

    it('reports an empty page as zero pages rather than one', async () => {
      repository.findAdminPage.mockResolvedValue({ items: [], total: 0 });

      const result = await service.listCustomers(query());

      expect(result.items).toEqual([]);
      expect(result.pagination).toEqual({
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
      });
    });
  });

  describe('getStats', () => {
    it('anchors the new-customer window 30 days back and echoes it', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-11T12:00:00.000Z'));
      try {
        repository.getStats.mockResolvedValue({
          totalCustomers: 32,
          activeCustomers: 30,
          newCustomers: 4,
          customersWithOrders: 9,
        });

        const stats = await service.getStats();

        expect(repository.getStats).toHaveBeenCalledWith(
          new Date('2026-10-12T12:00:00.000Z'),
        );
        expect(stats).toEqual({
          totalCustomers: 32,
          activeCustomers: 30,
          newCustomers: 4,
          customersWithOrders: 9,
          newCustomerWindowDays: 30,
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('getCustomer', () => {
    it('maps a missing customer — or an internal account — to a 404 before any further read', async () => {
      repository.findAdminCustomerById.mockResolvedValue(null);

      await expect(service.getCustomer(CUSTOMER_ID)).rejects.toThrow(
        NotFoundException,
      );
      expect(repository.findRecentOrders).not.toHaveBeenCalled();
      expect(repository.findAddresses).not.toHaveBeenCalled();
    });

    it('reads the recent orders and the address book, and maps the detail', async () => {
      repository.findAdminCustomerById.mockResolvedValue(customerRow());
      repository.findRecentOrders.mockResolvedValue([
        recentOrder({ payments: [{ id: 'p1' }] }),
      ]);
      repository.findAddresses.mockResolvedValue([addressRow()]);

      const result = await service.getCustomer(CUSTOMER_ID);

      expect(repository.findRecentOrders).toHaveBeenCalledWith(CUSTOMER_ID, 5);
      expect(repository.findAddresses).toHaveBeenCalledWith(CUSTOMER_ID);
      expect(result).toMatchObject({
        id: CUSTOMER_ID,
        firstName: 'Spend',
        lastName: 'Tester',
        emailVerifiedAt: null,
        totalOrders: 7,
        cancelledOrders: 1,
        spendingOrders: 4,
        lastOrderAt: new Date('2026-02-01T00:00:00.000Z'),
      });
      expect(result.recentOrders[0]).toMatchObject({
        orderNumber: 'ORD-20260104-AAAAAA',
        status: 'PENDING',
        paymentMethod: 'ABA_PAYWAY',
        totalAmount: '128.50',
        currency: 'USD',
        itemCount: 3,
        isPaid: true,
      });
      expect(result.addresses[0]).toMatchObject({
        label: 'Home',
        recipientName: 'Spend Tester',
        isDefault: true,
        countryCode: 'KH',
      });
    });

    it('marks an order paid only when money actually moved', async () => {
      repository.findAdminCustomerById.mockResolvedValue(customerRow());
      repository.findRecentOrders.mockResolvedValue([
        recentOrder({ payments: [{ id: 'p1' }] }),
        recentOrder({
          paymentMethod: 'COD',
          codCollections: [{ id: 'c1' }],
        }),
        recentOrder(),
      ]);
      repository.findAddresses.mockResolvedValue([]);

      const result = await service.getCustomer(CUSTOMER_ID);

      expect(result.recentOrders.map((order) => order.isPaid)).toEqual([
        true,
        true,
        false,
      ]);
    });

    it('divides spendable spend by spendable orders per currency, half-up', async () => {
      repository.findAdminCustomerById.mockResolvedValue(
        customerRow({
          total_spent_by_currency: [
            { currency: 'USD', amount: '100.00', orderCount: 3 },
            { currency: 'KHR', amount: '400000.00', orderCount: 1 },
            { currency: 'EUR', amount: '0.01', orderCount: 2 },
          ],
        }),
      );
      repository.findRecentOrders.mockResolvedValue([]);
      repository.findAddresses.mockResolvedValue([]);

      const result = await service.getCustomer(CUSTOMER_ID);

      expect(result.averageOrderValueByCurrency).toEqual([
        { currency: 'USD', amount: '33.33' },
        { currency: 'KHR', amount: '400000.00' },
        // 0.01 / 2 = 0.005, which rounds half-up rather than to even.
        { currency: 'EUR', amount: '0.01' },
      ]);
    });

    it('keeps both money lists empty for a customer without spendable orders', async () => {
      repository.findAdminCustomerById.mockResolvedValue(
        customerRow({ total_spent_by_currency: [] }),
      );
      repository.findRecentOrders.mockResolvedValue([]);
      repository.findAddresses.mockResolvedValue([]);

      const result = await service.getCustomer(CUSTOMER_ID);

      expect(result.totalSpentByCurrency).toEqual([]);
      expect(result.averageOrderValueByCurrency).toEqual([]);
    });
  });
});
