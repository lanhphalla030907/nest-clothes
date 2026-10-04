import {
  HttpStatus,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CartController } from './cart.controller.js';
import { CartService } from './cart.service.js';
import { AddCartItemDto } from './dto/add-cart-item.dto.js';
import {
  CartItemProductDto,
  CartItemResponseDto,
  CartItemVariantDto,
} from './dto/cart-item-response.dto.js';
import { CartResponseDto } from './dto/cart-response.dto.js';
import { UpdateCartItemDto } from './dto/update-cart-item.dto.js';
import { TEMPORARY_USER_ID_HEADER } from '../common/decorators/temporary-user-id.decorator.js';

const USER_ID = 'a1b2c3d4-e5f6-4f70-8a9b-0c1d2e3f4a5b';
const ITEM_ID = 'd2e3f4a5-b6c7-4d8e-9f0a-1b2c3d4e5f60';
const VARIANT_ID = 'e3f4a5b6-c7d8-4e9f-8a0b-2c3d4e5f6071';

const buildItemResponse = (
  overrides: Partial<CartItemResponseDto> = {},
): CartItemResponseDto =>
  Object.assign(new CartItemResponseDto(), {
    id: ITEM_ID,
    cartId: 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f',
    variantId: VARIANT_ID,
    quantity: 2,
    available: 8,
    exceedsAvailable: false,
    unitPrice: '19.99',
    lineTotal: '39.98',
    variant: Object.assign(new CartItemVariantDto(), {
      id: VARIANT_ID,
      sku: 'TSHIRT-BLK-M',
      price: '19.99',
      isActive: true,
      options: [{ optionName: 'Color', optionValue: 'Black' }],
    }),
    product: Object.assign(new CartItemProductDto(), {
      id: 'p-1',
      name: 'Oversized T-Shirt',
      slug: 'oversized-t-shirt',
      basePrice: '19.99',
      status: 'ACTIVE',
      isActive: true,
    }),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

const buildCartResponse = (
  overrides: Partial<CartResponseDto> = {},
): CartResponseDto =>
  Object.assign(new CartResponseDto(), {
    id: 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f',
    userId: USER_ID,
    items: [buildItemResponse()],
    itemCount: 2,
    subtotal: '39.98',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

const buildServiceMock = () => ({
  findCart: vi.fn(),
  addItem: vi.fn(),
  updateItem: vi.fn(),
  removeItem: vi.fn(),
  clearCart: vi.fn(),
});

describe('CartController', () => {
  let controller: CartController;
  let service: ReturnType<typeof buildServiceMock>;

  beforeEach(async () => {
    service = buildServiceMock();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CartController],
      providers: [{ provide: CartService, useValue: service }],
    }).compile();

    controller = module.get<CartController>(CartController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('delegates the read for the claimed user', () => {
    const expected = buildCartResponse();
    service.findCart.mockReturnValue(expected);

    expect(controller.findCart(USER_ID)).toBe(expected);
    expect(service.findCart).toHaveBeenCalledWith(USER_ID);
  });

  it('delegates the add with the parsed body', () => {
    const dto = Object.assign(new AddCartItemDto(), {
      variantId: VARIANT_ID,
      quantity: 2,
    });
    const expected = buildItemResponse();
    service.addItem.mockReturnValue(expected);

    expect(controller.addItem(USER_ID, dto)).toBe(expected);
    expect(service.addItem).toHaveBeenCalledWith(USER_ID, dto);
  });

  it('delegates the update with the item id from the path', () => {
    const dto = Object.assign(new UpdateCartItemDto(), { quantity: 3 });
    const expected = buildItemResponse({ quantity: 3 });
    service.updateItem.mockReturnValue(expected);

    expect(controller.updateItem(USER_ID, ITEM_ID, dto)).toBe(expected);
    expect(service.updateItem).toHaveBeenCalledWith(USER_ID, ITEM_ID, dto);
  });

  it('delegates the removal', () => {
    expect(controller.removeItem(USER_ID, ITEM_ID)).toBeUndefined();
    expect(service.removeItem).toHaveBeenCalledWith(USER_ID, ITEM_ID);
  });

  it('delegates the clear', () => {
    expect(controller.clearCart(USER_ID)).toBeUndefined();
    expect(service.clearCart).toHaveBeenCalledWith(USER_ID);
  });
});

describe('CartController (HTTP)', () => {
  let app: INestApplication;
  let service: ReturnType<typeof buildServiceMock>;
  let base: string;
  let userHeaders: Record<string, string>;

  beforeEach(async () => {
    service = buildServiceMock();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CartController],
      providers: [{ provide: CartService, useValue: service }],
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
    userHeaders = {
      'Content-Type': 'application/json',
      [TEMPORARY_USER_ID_HEADER]: USER_ID,
    };
  });

  afterEach(async () => {
    await app.close();
  });

  const request = (path: string, init: RequestInit = {}) =>
    fetch(`${base}/cart${path}`, {
      ...init,
      headers: { ...userHeaders, ...init.headers },
    });

  it('GET → 200 and the body exposes the exact cart fields', async () => {
    service.findCart.mockResolvedValue(buildCartResponse());

    const res = await request('');
    expect(res.status).toBe(HttpStatus.OK);

    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(
      [
        'createdAt',
        'id',
        'itemCount',
        'items',
        'subtotal',
        'updatedAt',
        'userId',
      ].sort(),
    );
    expect(service.findCart).toHaveBeenCalledWith(USER_ID);
  });

  it('GET exposes the exact line fields and leaks no user secrets', async () => {
    service.findCart.mockResolvedValue(buildCartResponse());

    const body = await (await request('')).json();

    expect(Object.keys(body.items[0]).sort()).toEqual(
      [
        'available',
        'cartId',
        'createdAt',
        'exceedsAvailable',
        'id',
        'lineTotal',
        'product',
        'quantity',
        'unitPrice',
        'updatedAt',
        'variant',
        'variantId',
      ].sort(),
    );
    expect(Object.keys(body.items[0].variant).sort()).toEqual(
      ['id', 'isActive', 'options', 'price', 'sku'].sort(),
    );
    expect(Object.keys(body.items[0].product).sort()).toEqual(
      ['basePrice', 'id', 'isActive', 'name', 'slug', 'status'].sort(),
    );
    expect(JSON.stringify(body)).not.toContain('passwordHash');
  });

  it('POST /cart/items → 201 and the service receives the parsed body', async () => {
    service.addItem.mockResolvedValue(buildItemResponse());

    const res = await request('/items', {
      method: 'POST',
      body: JSON.stringify({ variantId: VARIANT_ID, quantity: 2 }),
    });

    expect(res.status).toBe(HttpStatus.CREATED);
    const dto = service.addItem.mock.calls[0][1];
    expect(dto.variantId).toBe(VARIANT_ID);
    expect(dto.quantity).toBe(2);
    expect(service.addItem.mock.calls[0][0]).toBe(USER_ID);
  });

  it('PATCH /cart/items/:itemId → 200', async () => {
    service.updateItem.mockResolvedValue(buildItemResponse({ quantity: 3 }));

    const res = await request(`/items/${ITEM_ID}`, {
      method: 'PATCH',
      body: JSON.stringify({ quantity: 3 }),
    });

    expect(res.status).toBe(HttpStatus.OK);
    expect(service.updateItem.mock.calls[0].slice(0, 2)).toEqual([
      USER_ID,
      ITEM_ID,
    ]);
  });

  it('DELETE /cart/items/:itemId → 204 with an empty body', async () => {
    service.removeItem.mockResolvedValue(undefined);

    const res = await request(`/items/${ITEM_ID}`, { method: 'DELETE' });

    expect(res.status).toBe(HttpStatus.NO_CONTENT);
    expect(await res.text()).toBe('');
  });

  it('DELETE /cart → 204 with an empty body', async () => {
    service.clearCart.mockResolvedValue(undefined);

    const res = await request('', { method: 'DELETE' });

    expect(res.status).toBe(HttpStatus.NO_CONTENT);
    expect(await res.text()).toBe('');
    expect(service.clearCart).toHaveBeenCalledWith(USER_ID);
  });

  it('a missing identity header → 400 before the service runs', async () => {
    const res = await fetch(`${base}/cart`, {
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(service.findCart).not.toHaveBeenCalled();
  });

  it('a malformed identity header → 400 before the service runs', async () => {
    const res = await fetch(`${base}/cart`, {
      headers: { [TEMPORARY_USER_ID_HEADER]: 'not-a-uuid' },
    });

    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(service.findCart).not.toHaveBeenCalled();
  });

  it('a malformed item id → 400 before the service runs', async () => {
    const res = await request('/items/not-a-uuid', { method: 'DELETE' });

    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(service.removeItem).not.toHaveBeenCalled();
  });

  it('a malformed item id on PATCH → 400 before the service runs', async () => {
    const res = await request('/items/not-a-uuid', {
      method: 'PATCH',
      body: JSON.stringify({ quantity: 2 }),
    });

    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(service.updateItem).not.toHaveBeenCalled();
  });

  it('rejects a fractional quantity with 400', async () => {
    const res = await request('/items', {
      method: 'POST',
      body: JSON.stringify({ variantId: VARIANT_ID, quantity: 1.5 }),
    });

    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(service.addItem).not.toHaveBeenCalled();
  });

  it('rejects a zero quantity with 400', async () => {
    const res = await request('/items', {
      method: 'POST',
      body: JSON.stringify({ variantId: VARIANT_ID, quantity: 0 }),
    });

    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(service.addItem).not.toHaveBeenCalled();
  });

  it('rejects a negative quantity with 400', async () => {
    const res = await request('/items', {
      method: 'POST',
      body: JSON.stringify({ variantId: VARIANT_ID, quantity: -1 }),
    });

    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
  });

  it('rejects a missing quantity with 400', async () => {
    const res = await request('/items', {
      method: 'POST',
      body: JSON.stringify({ variantId: VARIANT_ID }),
    });

    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
  });

  it('rejects a malformed variant id with 400', async () => {
    const res = await request('/items', {
      method: 'POST',
      body: JSON.stringify({ variantId: 'not-a-uuid', quantity: 1 }),
    });

    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
  });

  it('rejects a numeric-string quantity with 400', async () => {
    const res = await request('/items', {
      method: 'POST',
      body: JSON.stringify({ variantId: VARIANT_ID, quantity: '2' }),
    });

    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
  });

  it('rejects forbidden identity fields in the body with 400', async () => {
    const res = await request('/items', {
      method: 'POST',
      body: JSON.stringify({
        variantId: VARIANT_ID,
        quantity: 1,
        id: ITEM_ID,
        cartId: 'someone-elses-cart',
      }),
    });

    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(service.addItem).not.toHaveBeenCalled();
  });

  it('rejects a forbidden identity field on PATCH with 400', async () => {
    const res = await request(`/items/${ITEM_ID}`, {
      method: 'PATCH',
      body: JSON.stringify({ quantity: 1, variantId: VARIANT_ID }),
    });

    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(service.updateItem).not.toHaveBeenCalled();
  });

  it('rejects a zero quantity on PATCH with 400', async () => {
    const res = await request(`/items/${ITEM_ID}`, {
      method: 'PATCH',
      body: JSON.stringify({ quantity: 0 }),
    });

    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(service.updateItem).not.toHaveBeenCalled();
  });
});
