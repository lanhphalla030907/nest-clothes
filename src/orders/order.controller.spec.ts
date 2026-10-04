import {
  HttpStatus,
  NotFoundException,
  RequestMethod,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TEMPORARY_USER_ID_HEADER } from '../common/decorators/temporary-user-id.decorator.js';
import { OrderItemResponseDto } from './dto/order-item-response.dto.js';
import { OrderResponseDto } from './dto/order-response.dto.js';
import { OrderSummaryResponseDto } from './dto/order-summary-response.dto.js';
import { OrderController } from './order.controller.js';
import { OrderService } from './order.service.js';

const USER_ID = 'a1b2c3d4-e5f6-4f70-8a9b-0c1d2e3f4a5b';
const OTHER_USER_ID = 'b2c3d4e5-f6a7-4b81-9c0d-1e2f3a4b5c6d';
const ORDER_ID = 'c3d4e5f6-a7b8-4c92-8d1e-2f3a4b5c6d7e';
const VARIANT_ID = 'e5f6a7b8-c9d0-4eb4-af30-4b5c6d7e8f90';

const buildItem = (
  overrides: Partial<OrderItemResponseDto> = {},
): OrderItemResponseDto =>
  Object.assign(new OrderItemResponseDto(), {
    id: 'a7b8c9d0-e1f2-4a3b-8c4d-5e6f7a8b9c0d',
    orderId: ORDER_ID,
    variantId: VARIANT_ID,
    productName: 'Wool Peacoat',
    sku: 'COAT-NAVY-M',
    variantOptionsSnapshot: [
      { optionName: 'Color', optionValue: 'Navy' },
      { optionName: 'Size', optionValue: 'M' },
    ],
    unitPrice: '129.00',
    quantity: 1,
    lineTotal: '129.00',
    createdAt: new Date('2026-01-04T11:30:00.000Z'),
    ...overrides,
  });

const buildSummary = (
  overrides: Partial<OrderSummaryResponseDto> = {},
): OrderSummaryResponseDto =>
  Object.assign(new OrderSummaryResponseDto(), {
    id: ORDER_ID,
    userId: USER_ID,
    orderNumber: 'ORD-20260104-AAAAAA',
    status: 'SHIPPED',
    subtotal: '129.00',
    shippingFee: '7.50',
    discountAmount: '8.00',
    totalAmount: '128.50',
    currency: 'USD',
    itemCount: 1,
    lineCount: 1,
    shippingRecipientName: 'Ada Lovelace',
    shippingCity: 'Bristol',
    shippingCountryCode: 'GB',
    createdAt: new Date('2026-01-04T11:30:00.000Z'),
    updatedAt: new Date('2026-01-04T11:30:00.000Z'),
    ...overrides,
  });

const buildOrder = (
  overrides: Partial<OrderResponseDto> = {},
): OrderResponseDto =>
  Object.assign(new OrderResponseDto(), {
    id: ORDER_ID,
    userId: USER_ID,
    orderNumber: 'ORD-20260104-AAAAAA',
    status: 'SHIPPED',
    subtotal: '129.00',
    shippingFee: '7.50',
    discountAmount: '8.00',
    totalAmount: '128.50',
    currency: 'USD',
    shippingRecipientName: 'Ada Lovelace',
    shippingPhone: '+15555550100',
    shippingAddressLine1: '18 Mill Lane',
    shippingAddressLine2: null,
    shippingCity: 'Bristol',
    shippingStateProvince: null,
    shippingPostalCode: 'BS1 4TR',
    shippingCountryCode: 'GB',
    items: [buildItem()],
    itemCount: 1,
    createdAt: new Date('2026-01-04T11:30:00.000Z'),
    updatedAt: new Date('2026-01-04T11:30:00.000Z'),
    ...overrides,
  });

const buildServiceMock = () => ({
  listOrders: vi.fn(),
  getOrder: vi.fn(),
});

/**
 * HTTP-level tests: the controller is mounted in a real Nest application with the
 * same global `ValidationPipe` the app uses, so routes, status codes and pipe
 * behaviour are exercised rather than assumed. The service is mocked, so what
 * arrives here is exactly what a controller is responsible for — including the
 * phase boundary, since a mutation route that does not exist cannot be asserted
 * against by a service mock alone.
 */
describe('OrderController (HTTP)', () => {
  let app: INestApplication;
  let service: ReturnType<typeof buildServiceMock>;
  let base: string;

  beforeAll(async () => {
    service = buildServiceMock();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [OrderController],
      providers: [{ provide: OrderService, useValue: service }],
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
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const request = (
    method: string,
    path: string,
    options: { user?: string; body?: unknown } = {},
  ) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        ...(options.user === undefined
          ? {}
          : { [TEMPORARY_USER_ID_HEADER]: options.user }),
        ...(options.body === undefined
          ? {}
          : { 'Content-Type': 'application/json' }),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    });

  describe('GET /orders', () => {
    it('returns 200 with the caller\'s summaries', async () => {
      service.listOrders.mockResolvedValue([buildSummary()]);

      const res = await request('GET', '/orders', { user: USER_ID });
      const body = await res.json();

      expect(res.status).toBe(HttpStatus.OK);
      expect(service.listOrders).toHaveBeenCalledWith(USER_ID);
      expect(body).toHaveLength(1);
      expect(body[0].orderNumber).toBe('ORD-20260104-AAAAAA');
    });

    it('returns 200 with an empty array when there are no orders', async () => {
      service.listOrders.mockResolvedValue([]);

      const res = await request('GET', '/orders', { user: USER_ID });

      expect(res.status).toBe(HttpStatus.OK);
      expect(await res.json()).toEqual([]);
    });

    it('exposes exactly the documented keys', async () => {
      service.listOrders.mockResolvedValue([buildSummary()]);

      const res = await request('GET', '/orders', { user: USER_ID });

      expect(Object.keys((await res.json())[0]).sort()).toEqual(
        [
          'createdAt',
          'currency',
          'discountAmount',
          'id',
          'itemCount',
          'lineCount',
          'orderNumber',
          'shippingCity',
          'shippingCountryCode',
          'shippingFee',
          'shippingRecipientName',
          'status',
          'subtotal',
          'totalAmount',
          'updatedAt',
          'userId',
        ].sort(),
      );
    });

    it('rejects a request without the identity header', async () => {
      const res = await request('GET', '/orders');

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(service.listOrders).not.toHaveBeenCalled();
    });

    it('rejects a malformed identity header before the service', async () => {
      const res = await request('GET', '/orders', { user: 'not-a-uuid' });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(service.listOrders).not.toHaveBeenCalled();
    });

    it('passes the service 404 through unchanged', async () => {
      service.listOrders.mockRejectedValue(
        new NotFoundException(`User ${OTHER_USER_ID} does not exist`),
      );

      const res = await request('GET', '/orders', { user: OTHER_USER_ID });

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
    });
  });

  describe('GET /orders/:id', () => {
    it('returns 200 with the order and its items', async () => {
      service.getOrder.mockResolvedValue(buildOrder());

      const res = await request('GET', `/orders/${ORDER_ID}`, { user: USER_ID });
      const body = await res.json();

      expect(res.status).toBe(HttpStatus.OK);
      expect(service.getOrder).toHaveBeenCalledWith(USER_ID, ORDER_ID);
      expect(body.items).toHaveLength(1);
      expect(body.items[0].productName).toBe('Wool Peacoat');
    });

    it('exposes exactly the documented keys, on the order and on each item', async () => {
      service.getOrder.mockResolvedValue(buildOrder());

      const res = await request('GET', `/orders/${ORDER_ID}`, { user: USER_ID });
      const body = await res.json();

      expect(Object.keys(body).sort()).toEqual(
        [
          'createdAt',
          'currency',
          'discountAmount',
          'id',
          'itemCount',
          'items',
          'orderNumber',
          'shippingAddressLine1',
          'shippingAddressLine2',
          'shippingCity',
          'shippingCountryCode',
          'shippingFee',
          'shippingPhone',
          'shippingPostalCode',
          'shippingRecipientName',
          'shippingStateProvince',
          'status',
          'subtotal',
          'totalAmount',
          'updatedAt',
          'userId',
        ].sort(),
      );
      expect(Object.keys(body.items[0]).sort()).toEqual(
        [
          'createdAt',
          'id',
          'lineTotal',
          'orderId',
          'productName',
          'quantity',
          'sku',
          'unitPrice',
          'variantId',
          'variantOptionsSnapshot',
        ].sort(),
      );
    });

    it('rejects a malformed order id before the service', async () => {
      const res = await request('GET', '/orders/not-a-uuid', { user: USER_ID });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(service.getOrder).not.toHaveBeenCalled();
    });

    it('rejects a malformed identity header before the service', async () => {
      const res = await request('GET', `/orders/${ORDER_ID}`, {
        user: 'not-a-uuid',
      });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(service.getOrder).not.toHaveBeenCalled();
    });

    it('returns 404 for an order that is not the caller\'s', async () => {
      service.getOrder.mockRejectedValue(
        new NotFoundException(`Order ${ORDER_ID} does not exist`),
      );

      const res = await request('GET', `/orders/${ORDER_ID}`, {
        user: OTHER_USER_ID,
      });

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
      expect(service.getOrder).toHaveBeenCalledWith(OTHER_USER_ID, ORDER_ID);
    });
  });

  describe('the surface is read-only', () => {
    it.each([
      ['POST', '/orders'],
      ['POST', `/orders/${ORDER_ID}`],
      ['PUT', `/orders/${ORDER_ID}`],
      ['PATCH', `/orders/${ORDER_ID}`],
      ['DELETE', `/orders/${ORDER_ID}`],
      ['POST', `/orders/${ORDER_ID}/cancel`],
      ['PATCH', `/orders/${ORDER_ID}/status`],
    ])('%s %s is not routed', async (method, path) => {
      const res = await request(method, path, {
        user: USER_ID,
        body: { status: 'CANCELLED' },
      });

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
      expect(service.listOrders).not.toHaveBeenCalled();
      expect(service.getOrder).not.toHaveBeenCalled();
    });

    it('is mounted at /orders and declares no other route', () => {
      expect(Reflect.getMetadata('path', OrderController)).toBe('orders');

      const prototype =
        OrderController.prototype as unknown as Record<string, unknown>;
      const methodNames = RequestMethod;
      const routes = Object.getOwnPropertyNames(prototype)
        .filter((name) => name !== 'constructor')
        .flatMap((name) => {
          const handler = prototype[name] as object;
          const path = Reflect.getMetadata('path', handler);
          const method = Reflect.getMetadata('method', handler) as number;

          return path === undefined
            ? []
            : [
                `${methodNames[method] ?? method} ${String(path)}`,
              ];
        })
        .sort();

      // Two handlers, both GET: there is no mutation route to advertise.
      expect(routes).toEqual(['GET /', 'GET :id']);
    });
  });
});
