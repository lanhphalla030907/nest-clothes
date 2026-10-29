import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  NotFoundException,
  RequestMethod,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TestIdentityRegistry } from '../../test/support/auth-fixtures.js';
import { Role } from '../generated/prisma/enums.js';
import { CheckoutController } from './checkout.controller.js';
import { CheckoutService } from './checkout.service.js';
import { CheckoutResponseDto } from './dto/checkout-response.dto.js';
import { CheckoutQuoteResponseDto } from './dto/checkout-quote-response.dto.js';

const USER_ID = 'a1b2c3d4-e5f6-4f70-8a9b-0c1d2e3f4a5b';
const ADDRESS_ID = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';
const UNKNOWN_USER_ID = 'd3e4f5a6-b7c8-4903-8d2e-4a5b6c7d8e9f';

const buildReceipt = (): CheckoutResponseDto =>
  Object.assign(new CheckoutResponseDto(), {
    id: 'c3d4e5f6-a7b8-4c92-8d1e-2f3a4b5c6d7e',
    userId: USER_ID,
    orderNumber: 'ORD-20260104-AAAAAA',
    status: 'PENDING',
    subtotal: '258.00',
    shippingFee: '0.00',
    discountAmount: '0.00',
    totalAmount: '258.00',
    currency: 'USD',
    shippingRecipientName: 'Ada Lovelace',
    shippingPhone: '+15555550100',
    shippingAddressLine1: '18 Mill Lane',
    shippingAddressLine2: null,
    shippingCity: 'Bristol',
    shippingStateProvince: null,
    shippingPostalCode: 'BS1 4TR',
    shippingCountryCode: 'GB',
    itemCount: 2,
    createdAt: new Date('2026-01-04T11:30:00.000Z'),
    updatedAt: new Date('2026-01-04T11:30:00.000Z'),
  });

/**
 * HTTP-level tests: the controller is mounted in a real Nest application with the
 * same global `ValidationPipe` the app uses, so the route, its status code and the
 * pipe behaviour are exercised rather than assumed.
 *
 * The service is mocked, so everything arriving here is a controller's
 * responsibility. The input contract is the interesting part — this phase accepts one
 * field, and the tests below pin that a client cannot add a second one. Under
 * `forbidNonWhitelisted`, a request carrying `totalAmount` is *rejected*, not
 * quietly stripped, and that difference is the whole reason the DTO is one field.
 */
describe('CheckoutController (HTTP)', () => {
  let app: INestApplication;
  let service: {
    checkout: ReturnType<typeof vi.fn>;
    createQuote: ReturnType<typeof vi.fn>;
  };
  let identities: TestIdentityRegistry;
  let base: string;

  beforeAll(async () => {
    service = {
      checkout: vi.fn().mockResolvedValue(buildReceipt()),
      createQuote: vi
        .fn()
        .mockResolvedValue(Object.assign(new CheckoutQuoteResponseDto(), {
          quoteId: 'c3d4e5f6-a7b8-4c92-8d1e-2f3a4b5c6d7e',
          totalAmount: '260.00',
        })),
    };
    identities = new TestIdentityRegistry();
    identities.register({
      id: USER_ID,
      email: 'ada@example.test',
      role: Role.CUSTOMER,
    });

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CheckoutController],
      providers: [
        ...identities.providers(),
        { provide: CheckoutService, useValue: service },
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
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** A checkout as the owning user sends it. */
  const post = (body: unknown, user: string = USER_ID) =>
    fetch(`${base}/checkout`, {
      method: 'POST',
      headers: {
        ...identities.bearerHeaderFor(user),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

  const postQuote = (body: unknown, user: string = USER_ID) =>
    fetch(`${base}/checkout/quote`, {
      method: 'POST',
      headers: {
        ...identities.bearerHeaderFor(user),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

  /**
   * The same request with no credentials at all.
   *
   * A separate helper rather than an argument, because a default parameter cannot
   * express "no header": passing `undefined` explicitly would trigger the default and
   * quietly send the very credential the test needs to prove is absent.
   */
  const postWithoutIdentity = (body: unknown) =>
    fetch(`${base}/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  describe('POST /checkout', () => {
    it('answers 201 with the order it created', async () => {
      const res = await post({ addressId: ADDRESS_ID });

      expect(res.status).toBe(HttpStatus.CREATED);
      await expect(res.json()).resolves.toMatchObject({
        orderNumber: 'ORD-20260104-AAAAAA',
        totalAmount: '258.00',
      });
    });

    it('accepts a quote ID and idempotency key without client totals', async () => {
      const request = {
        quoteId: 'd3e4f5a6-b7c8-4903-8d2e-4a5b6c7d8e9f',
        idempotencyKey: 'e4f5a6b7-c8d9-4012-9e3f-5a6b7c8d9e0f',
      };
      const res = await post(request);

      expect(res.status).toBe(HttpStatus.CREATED);
      expect(service.checkout).toHaveBeenCalledWith(USER_ID, request);
    });

    it('rejects totals on quote-backed checkout requests', async () => {
      const res = await post({
        quoteId: 'd3e4f5a6-b7c8-4903-8d2e-4a5b6c7d8e9f',
        idempotencyKey: 'e4f5a6b7-c8d9-4012-9e3f-5a6b7c8d9e0f',
        totalAmount: '0.01',
      });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(service.checkout).not.toHaveBeenCalled();
    });

    it('passes the claimed identity and the body to the service', async () => {
      await post({ addressId: ADDRESS_ID });

      expect(service.checkout).toHaveBeenCalledWith(USER_ID, {
        addressId: ADDRESS_ID,
      });
    });

    it('rejects a request with no body at all', async () => {
      const res = await post({});

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(service.checkout).not.toHaveBeenCalled();
    });

    it('rejects a missing addressId', async () => {
      const res = await post({ label: 'Home' });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(service.checkout).not.toHaveBeenCalled();
    });

    it('rejects a malformed address id', async () => {
      const res = await post({ addressId: 'not-a-uuid' });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(service.checkout).not.toHaveBeenCalled();
    });

    it('rejects a client that tries to state the total', async () => {
      const res = await post({ addressId: ADDRESS_ID, totalAmount: '0.01' });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      // Rejected outright: honouring the field would be a free order, and stripping
      // it silently would teach the client the field works.
      expect(service.checkout).not.toHaveBeenCalled();
    });

    it.each([
      ['a price', { unitPrice: '0.01' }],
      ['a status', { status: 'PAID' }],
      ['a quantity', { quantity: 99 }],
      ['a cart id', { cartId: ADDRESS_ID }],
      ['an address', { addressLine1: 'Somewhere else' }],
      ['a currency', { currency: 'EUR' }],
    ])('rejects %s in the body', async (_label, extra) => {
      const res = await post({ addressId: ADDRESS_ID, ...extra });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(service.checkout).not.toHaveBeenCalled();
    });

    it('rejects a request with no access token', async () => {
      const res = await postWithoutIdentity({ addressId: ADDRESS_ID });

      expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
      expect(service.checkout).not.toHaveBeenCalled();
    });

    it('rejects a well-formed token for a user who does not exist', async () => {
      const res = await post({ addressId: ADDRESS_ID }, UNKNOWN_USER_ID);

      expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
      expect(service.checkout).not.toHaveBeenCalled();
    });

    it('passes the service 404 for an unknown or unowned address through', async () => {
      service.checkout.mockRejectedValue(
        new NotFoundException(`Address ${ADDRESS_ID} does not exist`),
      );

      const res = await post({ addressId: ADDRESS_ID });

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
    });

    it('passes the service 400 for an empty cart through', async () => {
      service.checkout.mockRejectedValue(
        new BadRequestException('Cannot check out an empty cart'),
      );

      const res = await post({ addressId: ADDRESS_ID });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('passes the service 409 for insufficient stock through', async () => {
      service.checkout.mockRejectedValue(
        new ConflictException(
          'Requested quantity exceeds the available stock for this product variant',
        ),
      );

      const res = await post({ addressId: ADDRESS_ID });

      expect(res.status).toBe(HttpStatus.CONFLICT);
    });

    it('exposes only the checkout and quote POST routes', () => {
      const prototype = CheckoutController.prototype as unknown as Record<
        string,
        object
      >;
      const routes = Object.getOwnPropertyNames(prototype)
        .filter((name) => name !== 'constructor')
        .map((name) => ({
          method: Reflect.getMetadata('method', prototype[name]) as RequestMethod,
        }));

      expect(routes).toEqual([
        { method: RequestMethod.POST },
        { method: RequestMethod.POST },
      ]);
    });

    it('is mounted at /checkout', () => {
      expect(Reflect.getMetadata('path', CheckoutController)).toBe('checkout');
    });

    it('offers no route that could change an order', async () => {
      // Cancellation, payment and status transitions are explicitly out of scope, so
      // there must be no second verb on this path for a client to find later.
      const res = await fetch(`${base}/checkout`, {
        method: 'GET',
        headers: identities.bearerHeaderFor(USER_ID),
      });

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
    });

    describe('POST /checkout/quote', () => {
      const body = {
        addressId: ADDRESS_ID,
        shippingProviderId: 'd3e4f5a6-b7c8-4903-8d2e-4a5b6c7d8e9f',
        paymentMethod: 'ABA_PAYWAY',
      };

      it('authenticates and delegates a valid quote request', async () => {
        const response = await postQuote(body);
        expect(response.status).toBe(HttpStatus.CREATED);
        expect(service.createQuote).toHaveBeenCalledWith(USER_ID, body);
      });

      it('rejects a client-supplied shipping fee', async () => {
        const response = await postQuote({ ...body, shippingFee: '0.01' });
        expect(response.status).toBe(HttpStatus.BAD_REQUEST);
        expect(service.createQuote).not.toHaveBeenCalled();
      });

      it('accepts COD without a customer-selected area', async () => {
        const response = await postQuote({ ...body, paymentMethod: 'COD' });
        expect(response.status).toBe(HttpStatus.CREATED);
        expect(service.createQuote).toHaveBeenCalledWith(USER_ID, {
          ...body,
          paymentMethod: 'COD',
        });
      });

      it('rejects quote requests without authentication', async () => {
        const response = await fetch(`${base}/checkout/quote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
        expect(service.createQuote).not.toHaveBeenCalled();
      });
    });
  });
});
