import {
  ConflictException,
  HttpStatus,
  NotFoundException,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  TestIdentityRegistry,
  signRawToken,
} from '../../test/support/auth-fixtures.js';
import { Role } from '../generated/prisma/enums.js';
import { OrderService } from '../orders/order.service.js';
import { UsersRepository } from '../users/repositories/users.repository.js';
import { AdminOrdersController } from './controllers/admin-orders.controller.js';

const ADMIN_ID = 'a1b2c3d4-e5f6-4f70-8a9b-0c1d2e3f4a5b';
const CUSTOMER_ID = 'b2c3d4e5-f6a7-4b81-9c0d-1e2f3a4b5c6d';
const ORDER_ID = 'c3d4e5f6-a7b8-4c92-8d1e-2f3a4b5c6d7e';
const UNKNOWN_ID = 'd4e5f6a7-b8c9-4d03-9e2f-3a4b5c6d7e8f';

const listResponse = {
  items: [
    {
      id: ORDER_ID,
      orderNumber: 'ORD-20260104-AAAAAA',
      status: 'PENDING',
      customer: {
        id: CUSTOMER_ID,
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada@example.test',
      },
      subtotal: '129.00',
      shippingFee: '7.50',
      discountAmount: '8.00',
      totalAmount: '128.50',
      currency: 'USD',
      itemCount: 2,
      lineCount: 1,
      shippingRecipientName: 'Ada Lovelace',
      shippingCity: 'Bristol',
      shippingCountryCode: 'GB',
      payment: null,
      hasPaidPayment: false,
      createdAt: new Date('2026-01-04T11:30:00.000Z'),
      updatedAt: new Date('2026-01-04T11:30:00.000Z'),
    },
  ],
  pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
};

/**
 * `GET /admin/orders`, `GET /admin/orders/:id`, `POST /admin/orders/:id/cancel`
 * and `POST /admin/orders/:id/ship` over real HTTP.
 *
 * The repository and service are stubbed, so this file is about the HTTP
 * contract: the authorisation matrix, query validation, UUID parsing and the
 * shape that reaches the client. Database selection and filtering are pinned in
 * `order.repository.spec.ts`; the transitions and their SQL behaviour are
 * exercised for real in `test/admin-order-status.e2e-spec.ts`.
 */
describe('AdminOrdersController (HTTP)', () => {
  let app: INestApplication;
  let orderService: {
    listOrdersForAdmin: ReturnType<typeof vi.fn>;
    getOrderForAdmin: ReturnType<typeof vi.fn>;
    cancelOrderForAdmin: ReturnType<typeof vi.fn>;
    shipOrderForAdmin: ReturnType<typeof vi.fn>;
  };
  let identities: TestIdentityRegistry;
  let base: string;

  beforeAll(async () => {
    orderService = {
      listOrdersForAdmin: vi.fn().mockResolvedValue(listResponse),
      getOrderForAdmin: vi.fn().mockResolvedValue({
        id: ORDER_ID,
        orderNumber: 'ORD-20260104-AAAAAA',
        status: 'PENDING',
      }),
      cancelOrderForAdmin: vi.fn().mockResolvedValue({
        id: ORDER_ID,
        orderNumber: 'ORD-20260104-AAAAAA',
        status: 'CANCELLED',
      }),
      shipOrderForAdmin: vi.fn().mockResolvedValue({
        id: ORDER_ID,
        orderNumber: 'ORD-20260104-AAAAAA',
        status: 'SHIPPED',
      }),
    };

    identities = new TestIdentityRegistry();
    identities.register({
      id: ADMIN_ID,
      email: 'root@example.test',
      role: Role.ADMIN,
    });
    identities.register({
      id: CUSTOMER_ID,
      email: 'ada@example.test',
      role: Role.CUSTOMER,
    });

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminOrdersController],
      providers: [
        ...identities.providers(),
        { provide: UsersRepository, useValue: identities.findById() },
        { provide: OrderService, useValue: orderService },
      ],
    }).compile();

    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.listen(0);
    base = await app.getUrl();
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    orderService.listOrdersForAdmin.mockResolvedValue(listResponse);
    orderService.getOrderForAdmin.mockResolvedValue({
      id: ORDER_ID,
      orderNumber: 'ORD-20260104-AAAAAA',
      status: 'PENDING',
    });
    orderService.cancelOrderForAdmin.mockResolvedValue({
      id: ORDER_ID,
      orderNumber: 'ORD-20260104-AAAAAA',
      status: 'CANCELLED',
    });
    orderService.shipOrderForAdmin.mockResolvedValue({
      id: ORDER_ID,
      orderNumber: 'ORD-20260104-AAAAAA',
      status: 'SHIPPED',
    });
  });

  const get = (
    path: string,
    userId?: string,
    headers?: Record<string, string>,
  ) =>
    fetch(`${base}${path}`, {
      headers:
        headers ??
        (userId === undefined ? {} : identities.bearerHeaderFor(userId)),
    });

  const post = (
    path: string,
    userId?: string,
    headers?: Record<string, string>,
  ) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers:
        headers ??
        (userId === undefined ? {} : identities.bearerHeaderFor(userId)),
    });

  describe('authorisation', () => {
    it('lets an admin list orders', async () => {
      const res = await get('/admin/orders', ADMIN_ID);

      expect(res.status).toBe(HttpStatus.OK);
      await expect(res.json()).resolves.toMatchObject({
        pagination: { page: 1, limit: 20 },
      });
    });

    it('lets an admin read one order', async () => {
      const res = await get(`/admin/orders/${ORDER_ID}`, ADMIN_ID);

      expect(res.status).toBe(HttpStatus.OK);
      expect(orderService.getOrderForAdmin).toHaveBeenCalledWith(ORDER_ID);
    });

    it('refuses an unauthenticated caller with 401', async () => {
      const res = await get('/admin/orders');

      expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
      expect(orderService.listOrdersForAdmin).not.toHaveBeenCalled();
    });

    it('refuses a customer with 403', async () => {
      const res = await get('/admin/orders', CUSTOMER_ID);

      expect(res.status).toBe(HttpStatus.FORBIDDEN);
      expect(orderService.listOrdersForAdmin).not.toHaveBeenCalled();
    });

    it('refuses a correctly signed token whose database role is CUSTOMER', async () => {
      const forged = signRawToken({
        sub: CUSTOMER_ID,
        email: 'ada@example.test',
        role: Role.ADMIN,
      });

      const res = await get('/admin/orders', undefined, {
        Authorization: `Bearer ${forged}`,
      });

      expect(res.status).toBe(HttpStatus.FORBIDDEN);
      expect(orderService.listOrdersForAdmin).not.toHaveBeenCalled();
    });

    it('refuses a customer on the detail route too', async () => {
      const res = await get(`/admin/orders/${ORDER_ID}`, CUSTOMER_ID);

      expect(res.status).toBe(HttpStatus.FORBIDDEN);
      expect(orderService.getOrderForAdmin).not.toHaveBeenCalled();
    });

    it.each(['/cancel', '/ship'])(
      'refuses an unauthenticated caller on POST %s with 401',
      async (action) => {
        const res = await post(`/admin/orders/${ORDER_ID}${action}`);

        expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
      },
    );

    it.each(['/cancel', '/ship'])(
      'refuses a customer on POST %s with 403',
      async (action) => {
        const res = await post(
          `/admin/orders/${ORDER_ID}${action}`,
          CUSTOMER_ID,
        );

        expect(res.status).toBe(HttpStatus.FORBIDDEN);
      },
    );

    it('lets an admin cancel an order', async () => {
      const res = await post(`/admin/orders/${ORDER_ID}/cancel`, ADMIN_ID);

      expect(res.status).toBe(HttpStatus.OK);
      expect(orderService.cancelOrderForAdmin).toHaveBeenCalledWith(ORDER_ID);
    });

    it('lets an admin ship an order', async () => {
      const res = await post(`/admin/orders/${ORDER_ID}/ship`, ADMIN_ID);

      expect(res.status).toBe(HttpStatus.OK);
      expect(orderService.shipOrderForAdmin).toHaveBeenCalledWith(ORDER_ID);
    });
  });

  describe('the list query', () => {
    it('applies the documented defaults', async () => {
      await get('/admin/orders', ADMIN_ID);

      expect(orderService.listOrdersForAdmin).toHaveBeenCalledWith(
        expect.objectContaining({ page: 1, limit: 20 }),
      );
    });

    it('passes valid filters through, with the search trimmed', async () => {
      await get(
        `/admin/orders?page=2&limit=5&status=CONFIRMED&search=%20Ada%20&createdFrom=2026-01-01T00:00:00.000Z&createdTo=2026-01-31T23:59:59.000Z`,
        ADMIN_ID,
      );

      expect(orderService.listOrdersForAdmin).toHaveBeenCalledWith(
        expect.objectContaining({
          page: 2,
          limit: 5,
          status: 'CONFIRMED',
          search: 'Ada',
          createdFrom: '2026-01-01T00:00:00.000Z',
          createdTo: '2026-01-31T23:59:59.000Z',
        }),
      );
    });

    it.each([
      'page=0',
      'page=-1',
      'page=1.5',
      'page=abc',
      'limit=0',
      'limit=101',
    ])('rejects %s with 400', async (query) => {
      const res = await get(`/admin/orders?${query}`, ADMIN_ID);

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(orderService.listOrdersForAdmin).not.toHaveBeenCalled();
    });

    it('rejects an unknown status with 400', async () => {
      const res = await get('/admin/orders?status=REFUNDED', ADMIN_ID);

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(orderService.listOrdersForAdmin).not.toHaveBeenCalled();
    });

    it('rejects an invalid timestamp with 400', async () => {
      const res = await get('/admin/orders?createdFrom=not-a-date', ADMIN_ID);

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(orderService.listOrdersForAdmin).not.toHaveBeenCalled();
    });

    it('rejects a search longer than 200 characters with 400', async () => {
      const res = await get(
        `/admin/orders?search=${'a'.repeat(201)}`,
        ADMIN_ID,
      );

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(orderService.listOrdersForAdmin).not.toHaveBeenCalled();
    });

    it('rejects an unknown query parameter rather than ignoring it', async () => {
      const res = await get('/admin/orders?customerId=someone', ADMIN_ID);

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(orderService.listOrdersForAdmin).not.toHaveBeenCalled();
    });
  });

  describe('the detail route', () => {
    it('rejects a malformed id with 400 before the service', async () => {
      const res = await get('/admin/orders/not-a-uuid', ADMIN_ID);

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(orderService.getOrderForAdmin).not.toHaveBeenCalled();
    });

    it('passes a 404 through for an order that does not exist', async () => {
      orderService.getOrderForAdmin.mockRejectedValue(
        new NotFoundException('Order does not exist'),
      );

      const res = await get(`/admin/orders/${UNKNOWN_ID}`, ADMIN_ID);

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
    });
  });

  describe('the status actions', () => {
    it.each(['cancel', 'ship'])(
      'rejects a malformed id on %s with 400 before the service',
      async (action) => {
        const res = await post(`/admin/orders/not-a-uuid/${action}`, ADMIN_ID);

        expect(res.status).toBe(HttpStatus.BAD_REQUEST);
        expect(orderService.cancelOrderForAdmin).not.toHaveBeenCalled();
        expect(orderService.shipOrderForAdmin).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['cancel', 'cancelOrderForAdmin'],
      ['ship', 'shipOrderForAdmin'],
    ] as const)('passes a 404 through for %s', async (action, method) => {
      orderService[method].mockRejectedValue(
        new NotFoundException('Order does not exist'),
      );

      const res = await post(`/admin/orders/${UNKNOWN_ID}/${action}`, ADMIN_ID);

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
    });

    it.each([
      ['cancel', 'cancelOrderForAdmin'],
      ['ship', 'shipOrderForAdmin'],
    ] as const)(
      'passes an unsupported-transition 409 through for %s',
      async (action, method) => {
        orderService[method].mockRejectedValue(
          new ConflictException('Order cannot transition'),
        );

        const res = await post(`/admin/orders/${ORDER_ID}/${action}`, ADMIN_ID);

        expect(res.status).toBe(HttpStatus.CONFLICT);
      },
    );
  });
});
