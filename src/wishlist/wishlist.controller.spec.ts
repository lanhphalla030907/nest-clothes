import {
  HttpStatus,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TEMPORARY_USER_ID_HEADER } from '../common/decorators/temporary-user-id.decorator.js';
import { WishlistController } from './wishlist.controller.js';
import { WishlistService } from './wishlist.service.js';
import { AddWishlistItemDto } from './dto/add-wishlist-item.dto.js';
import {
  WishlistItemImageDto,
  WishlistItemProductDto,
  WishlistItemResponseDto,
  WishlistItemVariantDto,
} from './dto/wishlist-item-response.dto.js';
import { WishlistResponseDto } from './dto/wishlist-response.dto.js';

const USER_ID = 'a1b2c3d4-e5f6-4f70-8a9b-0c1d2e3f4a5b';
const ITEM_ID = 'd2e3f4a5-b6c7-4d8e-9f0a-1b2c3d4e5f60';
const WISHLIST_ID = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f';
const PRODUCT_ID = 'e3f4a5b6-c7d8-4e9f-8a0b-2c3d4e5f6071';

const buildItemResponse = (
  overrides: Partial<WishlistItemResponseDto> = {},
): WishlistItemResponseDto =>
  Object.assign(new WishlistItemResponseDto(), {
    id: ITEM_ID,
    wishlistId: WISHLIST_ID,
    productId: PRODUCT_ID,
    product: Object.assign(new WishlistItemProductDto(), {
      id: PRODUCT_ID,
      name: 'Oversized T-Shirt',
      slug: 'oversized-t-shirt',
      basePrice: '19.99',
      status: 'ACTIVE',
      isActive: true,
      image: Object.assign(new WishlistItemImageDto(), {
        imageUrl: 'https://cdn.example.com/front.jpg',
        altText: 'Front',
      }),
      priceRange: { min: '19.99', max: '19.99' },
      inStock: true,
      variants: [
        Object.assign(new WishlistItemVariantDto(), {
          id: 'v-1',
          sku: 'TSHIRT-BLK-M',
          price: '19.99',
          available: 8,
          options: [{ optionName: 'Color', optionValue: 'Black' }],
        }),
      ],
    }),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

const buildWishlistResponse = (
  overrides: Partial<WishlistResponseDto> = {},
): WishlistResponseDto =>
  Object.assign(new WishlistResponseDto(), {
    id: WISHLIST_ID,
    userId: USER_ID,
    items: [buildItemResponse()],
    itemCount: 1,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

const buildServiceMock = () => ({
  findWishlist: vi.fn(),
  addItem: vi.fn(),
  removeItem: vi.fn(),
  clearWishlist: vi.fn(),
});

/**
 * HTTP-level tests: the controller is mounted in a real Nest application with the
 * same global `ValidationPipe` the app uses, so status codes, the routes and the
 * request validation are exercised rather than assumed. The service is mocked, so
 * what arrives here is exactly what a controller is responsible for.
 */
describe('WishlistController (HTTP)', () => {
  let app: INestApplication;
  let service: ReturnType<typeof buildServiceMock>;
  let base: string;

  beforeAll(async () => {
    service = buildServiceMock();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [WishlistController],
      providers: [{ provide: WishlistService, useValue: service }],
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

  describe('GET /wishlist', () => {
    it('returns 200 with the wishlist for the claimed user', async () => {
      service.findWishlist.mockResolvedValue(buildWishlistResponse());

      const res = await request('GET', '/wishlist', { user: USER_ID });
      const body = await res.json();

      expect(res.status).toBe(HttpStatus.OK);
      expect(service.findWishlist).toHaveBeenCalledWith(USER_ID);
      expect(body.userId).toBe(USER_ID);
      expect(body.itemCount).toBe(1);
    });

    it('exposes exactly the documented keys', async () => {
      service.findWishlist.mockResolvedValue(buildWishlistResponse());

      const res = await request('GET', '/wishlist', { user: USER_ID });

      expect(Object.keys(await res.json()).sort()).toEqual(
        ['createdAt', 'id', 'itemCount', 'items', 'updatedAt', 'userId'].sort(),
      );
    });

    it('rejects a request without the identity header', async () => {
      const res = await request('GET', '/wishlist');

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(service.findWishlist).not.toHaveBeenCalled();
    });

    it('rejects a malformed identity header before the service', async () => {
      const res = await request('GET', '/wishlist', { user: 'not-a-uuid' });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(service.findWishlist).not.toHaveBeenCalled();
    });
  });

  describe('POST /wishlist/items', () => {
    it('returns 201 and passes the parsed body to the service', async () => {
      service.addItem.mockResolvedValue(buildItemResponse());

      const res = await request('POST', '/wishlist/items', {
        user: USER_ID,
        body: { productId: PRODUCT_ID },
      });
      const body = await res.json();

      expect(res.status).toBe(HttpStatus.CREATED);
      expect(service.addItem).toHaveBeenCalledWith(
        USER_ID,
        expect.objectContaining({ productId: PRODUCT_ID }),
      );
      expect(body.productId).toBe(PRODUCT_ID);
    });

    it('exposes the current product, the image and the derived availability', async () => {
      service.addItem.mockResolvedValue(buildItemResponse());

      const body = await (
        await request('POST', '/wishlist/items', {
          user: USER_ID,
          body: { productId: PRODUCT_ID },
        })
      ).json();

      expect(body.product.name).toBe('Oversized T-Shirt');
      expect(body.product.image.imageUrl).toBe(
        'https://cdn.example.com/front.jpg',
      );
      expect(body.product.priceRange).toEqual({
        min: '19.99',
        max: '19.99',
      });
      expect(body.product.inStock).toBe(true);
      expect(body.product.variants[0].available).toBe(8);
    });

    it('never serialises a user row or a password hash', async () => {
      service.addItem.mockResolvedValue(buildItemResponse());

      const text = await (
        await request('POST', '/wishlist/items', {
          user: USER_ID,
          body: { productId: PRODUCT_ID },
        })
      ).text();

      expect(text).not.toContain('passwordHash');
      expect(text).not.toContain('"user"');
    });

    it('rejects a missing productId', async () => {
      const res = await request('POST', '/wishlist/items', {
        user: USER_ID,
        body: {},
      });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(service.addItem).not.toHaveBeenCalled();
    });

    it('rejects a malformed productId', async () => {
      const res = await request('POST', '/wishlist/items', {
        user: USER_ID,
        body: { productId: 'nope' },
      });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('rejects a quantity, which a wishlist has no concept of', async () => {
      const res = await request('POST', '/wishlist/items', {
        user: USER_ID,
        body: { productId: PRODUCT_ID, quantity: 2 },
      });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(service.addItem).not.toHaveBeenCalled();
    });

    it('rejects unknown fields rather than ignoring them', async () => {
      const res = await request('POST', '/wishlist/items', {
        user: USER_ID,
        body: { productId: PRODUCT_ID, wishlistId: WISHLIST_ID },
      });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(service.addItem).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /wishlist/items/:itemId', () => {
    it('returns 204 with no body', async () => {
      service.removeItem.mockResolvedValue(undefined);

      const res = await request('DELETE', `/wishlist/items/${ITEM_ID}`, {
        user: USER_ID,
      });

      expect(res.status).toBe(HttpStatus.NO_CONTENT);
      expect(await res.text()).toBe('');
      expect(service.removeItem).toHaveBeenCalledWith(USER_ID, ITEM_ID);
    });

    it('rejects a malformed item id before the service', async () => {
      const res = await request('DELETE', '/wishlist/items/not-a-uuid', {
        user: USER_ID,
      });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(service.removeItem).not.toHaveBeenCalled();
    });

    it('surfaces the service 404 for another user item', async () => {
      const { NotFoundException } = await import('@nestjs/common');
      service.removeItem.mockRejectedValue(
        new NotFoundException(`Wishlist item ${ITEM_ID} does not exist`),
      );

      const res = await request('DELETE', `/wishlist/items/${ITEM_ID}`, {
        user: USER_ID,
      });

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
    });
  });

  describe('DELETE /wishlist', () => {
    it('returns 204 with no body', async () => {
      service.clearWishlist.mockResolvedValue(undefined);

      const res = await request('DELETE', '/wishlist', { user: USER_ID });

      expect(res.status).toBe(HttpStatus.NO_CONTENT);
      expect(await res.text()).toBe('');
      expect(service.clearWishlist).toHaveBeenCalledWith(USER_ID);
    });

    it('rejects a malformed identity header', async () => {
      const res = await request('DELETE', '/wishlist', { user: 'nope' });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(service.clearWishlist).not.toHaveBeenCalled();
    });
  });

  describe('the controller itself', () => {
    it('delegates the read directly', () => {
      const controller = app.get(WishlistController);
      const expected = buildWishlistResponse();
      service.findWishlist.mockReturnValue(expected);

      expect(controller.findWishlist(USER_ID)).toBe(expected);
    });

    it('delegates the add with the DTO instance', () => {
      const controller = app.get(WishlistController);
      const dto = Object.assign(new AddWishlistItemDto(), {
        productId: PRODUCT_ID,
      });
      const expected = buildItemResponse();
      service.addItem.mockReturnValue(expected);

      expect(controller.addItem(USER_ID, dto)).toBe(expected);
      expect(service.addItem).toHaveBeenCalledWith(USER_ID, dto);
    });
  });
});
