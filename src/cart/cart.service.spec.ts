import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '../generated/prisma/client.js';
import { InventoryRepository } from '../inventory/repositories/inventory.repository.js';
import { ProductVariantsRepository } from '../product-variants/repositories/product-variants.repository.js';
import { UsersRepository } from '../users/repositories/users.repository.js';
import { CartService } from './cart.service.js';
import { AddCartItemDto } from './dto/add-cart-item.dto.js';
import { UpdateCartItemDto } from './dto/update-cart-item.dto.js';
import { CartRepository } from './repositories/cart.repository.js';

const USER_ID = 'a1b2c3d4-e5f6-4f70-8a9b-0c1d2e3f4a5b';
const CART_ID = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f';
const ITEM_ID = 'd2e3f4a5-b6c7-4d8e-9f0a-1b2c3d4e5f60';
const VARIANT_ID = 'e3f4a5b6-c7d8-4e9f-8a0b-2c3d4e5f6071';
const OTHER_VARIANT_ID = 'f4a5b6c7-d8e9-4f0a-9b1c-3d4e5f607182';

const buildAddDto = (overrides: Partial<AddCartItemDto> = {}): AddCartItemDto =>
  Object.assign(new AddCartItemDto(), overrides);

const buildUpdateDto = (
  overrides: Partial<UpdateCartItemDto> = {},
): UpdateCartItemDto => Object.assign(new UpdateCartItemDto(), overrides);

const buildUser = (overrides: Record<string, unknown> = {}) => ({
  id: USER_ID,
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.com',
  passwordHash: 'argon2-hash',
  phone: null,
  status: 'ACTIVE',
  emailVerifiedAt: null,
  lastLoginAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

const buildVariant = (overrides: Record<string, unknown> = {}) => ({
  id: VARIANT_ID,
  productId: 'p-1',
  sku: 'TSHIRT-BLK-M',
  price: '19.99',
  isActive: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

const buildInventory = (overrides: Record<string, unknown> = {}) => ({
  id: 'i-1',
  variantId: VARIANT_ID,
  quantity: 10,
  reservedQuantity: 0,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

const buildCatalog = (
  variantId: string,
  overrides: Record<string, unknown> = {},
) => ({
  id: ITEM_ID,
  cartId: CART_ID,
  variantId,
  quantity: 2,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  variant: {
    id: variantId,
    productId: 'p-1',
    sku: 'TSHIRT-BLK-M',
    price: '19.99',
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    options: [
      { id: 'vo-1', optionName: 'Color', optionValue: 'Black' },
      { id: 'vo-2', optionName: 'Size', optionValue: 'M' },
    ],
    product: {
      id: 'p-1',
      categoryId: 'cat-1',
      name: 'Oversized T-Shirt',
      slug: 'oversized-t-shirt',
      description: null,
      basePrice: '19.99',
      status: 'ACTIVE',
      isActive: true,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    },
    inventory: { id: 'i-1', quantity: 10, reservedQuantity: 0 },
  },
  ...overrides,
});

const buildCart = (overrides: Record<string, unknown> = {}) => ({
  id: CART_ID,
  userId: USER_ID,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  items: [],
  ...overrides,
});

const buildUniqueViolation = (
  modelName: string,
  meta?: Record<string, unknown>,
) =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '7.10.0',
    meta: {
      modelName,
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          originalCode: '23505',
          kind: 'UniqueConstraintViolation',
          constraint: { index: 'cart_items_cart_id_variant_id_key' },
          table: 'cart_items',
        },
      },
      ...meta,
    },
  });

const buildVariantRestrictViolation = () =>
  new Prisma.PrismaClientKnownRequestError('Foreign key constraint failed', {
    code: 'P2003',
    clientVersion: '7.10.0',
    meta: {
      modelName: 'CartItem',
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          originalCode: '23503',
          kind: 'ForeignKeyViolation',
          constraint: { index: 'cart_items_variant_id_fkey' },
          table: 'cart_items',
        },
      },
    },
  });

describe('CartService', () => {
  let service: CartService;
  let cartFindByUserId: ReturnType<typeof vi.fn>;
  let cartCreateForUser: ReturnType<typeof vi.fn>;
  let cartFindItemByCartAndVariant: ReturnType<typeof vi.fn>;
  let cartFindItemByIdAndCart: ReturnType<typeof vi.fn>;
  let cartCreateItem: ReturnType<typeof vi.fn>;
  let cartIncrementWithinAvailable: ReturnType<typeof vi.fn>;
  let cartUpdateItemQuantity: ReturnType<typeof vi.fn>;
  let cartDeleteItemByIdAndCart: ReturnType<typeof vi.fn>;
  let cartDeleteItemsByCart: ReturnType<typeof vi.fn>;
  let cartRunInTransaction: ReturnType<typeof vi.fn>;
  let inventoryFindByVariantId: ReturnType<typeof vi.fn>;
  let inventoryUpdate: ReturnType<typeof vi.fn>;
  let variantFindById: ReturnType<typeof vi.fn>;
  let userFindById: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    cartFindByUserId = vi.fn();
    cartCreateForUser = vi.fn();
    cartFindItemByCartAndVariant = vi.fn();
    cartFindItemByIdAndCart = vi.fn();
    cartCreateItem = vi.fn();
    cartIncrementWithinAvailable = vi.fn();
    cartUpdateItemQuantity = vi.fn();
    cartDeleteItemByIdAndCart = vi.fn();
    cartDeleteItemsByCart = vi.fn();
    cartRunInTransaction = vi
      .fn()
      .mockImplementation((work: (tx: unknown) => Promise<unknown>) =>
        work({ tx: true }),
      );
    inventoryFindByVariantId = vi.fn();
    inventoryUpdate = vi.fn();
    variantFindById = vi.fn();
    userFindById = vi.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CartService,
        {
          provide: CartRepository,
          useValue: {
            findByUserId: cartFindByUserId,
            createForUser: cartCreateForUser,
            findItemByCartAndVariant: cartFindItemByCartAndVariant,
            findItemByIdAndCart: cartFindItemByIdAndCart,
            createItem: cartCreateItem,
            incrementItemQuantityWithinAvailable: cartIncrementWithinAvailable,
            updateItemQuantity: cartUpdateItemQuantity,
            deleteItemByIdAndCart: cartDeleteItemByIdAndCart,
            deleteItemsByCart: cartDeleteItemsByCart,
            runInTransaction: cartRunInTransaction,
          },
        },
        {
          provide: InventoryRepository,
          useValue: {
            findByVariantId: inventoryFindByVariantId,
            update: inventoryUpdate,
          },
        },
        {
          provide: ProductVariantsRepository,
          useValue: { findById: variantFindById },
        },
        { provide: UsersRepository, useValue: { findById: userFindById } },
      ],
    }).compile();

    service = module.get<CartService>(CartService);

    userFindById.mockResolvedValue(buildUser());
    variantFindById.mockResolvedValue(buildVariant());
    inventoryFindByVariantId.mockResolvedValue(buildInventory());
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('findCart', () => {
    it('returns the existing cart with its items', async () => {
      cartFindByUserId.mockResolvedValue(
        buildCart({ items: [buildCatalog(VARIANT_ID)] }),
      );

      const result = await service.findCart(USER_ID);

      expect(result.id).toBe(CART_ID);
      expect(result.userId).toBe(USER_ID);
      expect(result.items).toHaveLength(1);
    });

    it('creates the cart on first read', async () => {
      cartFindByUserId.mockResolvedValueOnce(null).mockResolvedValue(null);
      cartCreateForUser.mockResolvedValue(buildCart());

      const result = await service.findCart(USER_ID);

      expect(cartCreateForUser).toHaveBeenCalledWith(USER_ID);
      expect(result.items).toEqual([]);
      expect(result.subtotal).toBe('0.00');
      expect(result.itemCount).toBe(0);
    });

    it('re-reads instead of surfacing a concurrent first-cart conflict', async () => {
      const winnerCart = buildCart();
      cartFindByUserId
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(winnerCart);
      cartCreateForUser.mockRejectedValue(
        buildUniqueViolation('Cart', { target: ['userId'] }),
      );

      await expect(service.findCart(USER_ID)).resolves.toEqual(
        expect.objectContaining({ id: CART_ID, userId: USER_ID }),
      );
      expect(cartCreateForUser).toHaveBeenCalledTimes(1);
    });

    it('propagates an unrelated create failure', async () => {
      const failure = buildUniqueViolation('SomethingElse');
      cartFindByUserId.mockResolvedValue(null);
      cartCreateForUser.mockRejectedValue(failure);

      await expect(service.findCart(USER_ID)).rejects.toBe(failure);
    });

    it('unknown user → 404 and no cart is created', async () => {
      userFindById.mockResolvedValue(null);

      await expect(service.findCart(USER_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(cartCreateForUser).not.toHaveBeenCalled();
    });

    it('exposes current variant, product and inventory for every line', async () => {
      cartFindByUserId.mockResolvedValue(
        buildCart({
          items: [
            buildCatalog(VARIANT_ID, {
              quantity: 3,
              variant: {
                ...buildCatalog(VARIANT_ID).variant,
                inventory: { id: 'i-1', quantity: 10, reservedQuantity: 4 },
              },
            }),
          ],
        }),
      );

      const result = await service.findCart(USER_ID);

      expect(result.items[0]).toMatchObject({
        variantId: VARIANT_ID,
        quantity: 3,
        unitPrice: '19.99',
        lineTotal: '59.97',
        available: 6,
        exceedsAvailable: false,
      });
      expect(result.items[0].variant.sku).toBe('TSHIRT-BLK-M');
      expect(result.items[0].variant.options).toEqual([
        { optionName: 'Color', optionValue: 'Black' },
        { optionName: 'Size', optionValue: 'M' },
      ]);
      expect(result.items[0].product.slug).toBe('oversized-t-shirt');
      expect(result.itemCount).toBe(3);
      expect(result.subtotal).toBe('59.97');
    });

    it('flags a line whose stock shrank after it was added', async () => {
      cartFindByUserId.mockResolvedValue(
        buildCart({
          items: [
            buildCatalog(VARIANT_ID, {
              quantity: 5,
              variant: {
                ...buildCatalog(VARIANT_ID).variant,
                inventory: { id: 'i-1', quantity: 5, reservedQuantity: 3 },
              },
            }),
          ],
        }),
      );

      const result = await service.findCart(USER_ID);

      expect(result.items[0].available).toBe(2);
      expect(result.items[0].exceedsAvailable).toBe(true);
    });

    it('never exposes any user column on the cart response', async () => {
      cartFindByUserId.mockResolvedValue(buildCart());

      const result = await service.findCart(USER_ID);

      expect(Object.keys(result).sort()).toEqual([
        'createdAt',
        'id',
        'itemCount',
        'items',
        'subtotal',
        'updatedAt',
        'userId',
      ]);
      expect(JSON.stringify(result)).not.toContain('passwordHash');
    });
  });

  describe('addItem', () => {
    beforeEach(() => {
      cartFindByUserId.mockResolvedValue(buildCart());
      cartFindItemByCartAndVariant.mockResolvedValue(null);
      cartCreateItem.mockImplementation((data: Record<string, unknown>) =>
        Promise.resolve(buildCatalog(String(data.variantId), data)),
      );
    });

    it('creates a line for a variant the cart does not hold yet', async () => {
      const result = await service.addItem(
        USER_ID,
        buildAddDto({ variantId: VARIANT_ID, quantity: 2 }),
      );

      expect(cartCreateItem).toHaveBeenCalledWith(
        { cartId: CART_ID, variantId: VARIANT_ID, quantity: 2 },
        { tx: true },
      );
      expect(result.quantity).toBe(2);
    });

    it('runs the read-then-write inside a transaction', async () => {
      await service.addItem(
        USER_ID,
        buildAddDto({ variantId: VARIANT_ID, quantity: 2 }),
      );

      expect(cartRunInTransaction).toHaveBeenCalledTimes(1);
    });

    it('increments an existing line instead of inserting a duplicate', async () => {
      cartFindItemByCartAndVariant.mockResolvedValue(
        buildCatalog(VARIANT_ID, { quantity: 2 }),
      );
      cartIncrementWithinAvailable.mockResolvedValue(1);
      cartFindItemByIdAndCart.mockResolvedValue(
        buildCatalog(VARIANT_ID, { quantity: 5 }),
      );

      const result = await service.addItem(
        USER_ID,
        buildAddDto({ variantId: VARIANT_ID, quantity: 3 }),
      );

      expect(cartCreateItem).not.toHaveBeenCalled();
      expect(cartIncrementWithinAvailable).toHaveBeenCalledWith(
        ITEM_ID,
        3,
        10,
        { tx: true },
      );
      expect(result.quantity).toBe(5);
    });

    it('validates the resulting total, not just the increment', async () => {
      cartFindItemByCartAndVariant.mockResolvedValue(
        buildCatalog(VARIANT_ID, { quantity: 9 }),
      );

      await expect(
        service.addItem(
          USER_ID,
          buildAddDto({ variantId: VARIANT_ID, quantity: 2 }),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(cartIncrementWithinAvailable).not.toHaveBeenCalled();
    });

    it('rejects a request larger than the available stock', async () => {
      await expect(
        service.addItem(
          USER_ID,
          buildAddDto({ variantId: VARIANT_ID, quantity: 11 }),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(cartCreateItem).not.toHaveBeenCalled();
    });

    it('compares against available, not against total stock', async () => {
      inventoryFindByVariantId.mockResolvedValue(
        buildInventory({ quantity: 10, reservedQuantity: 4 }),
      );

      await expect(
        service.addItem(
          USER_ID,
          buildAddDto({ variantId: VARIANT_ID, quantity: 7 }),
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      await expect(
        service.addItem(
          USER_ID,
          buildAddDto({ variantId: VARIANT_ID, quantity: 6 }),
        ),
      ).resolves.toBeDefined();
    });

    it('reads stock but never writes it, so nothing is reserved', async () => {
      await service.addItem(
        USER_ID,
        buildAddDto({ variantId: VARIANT_ID, quantity: 2 }),
      );

      expect(inventoryFindByVariantId).toHaveBeenCalledTimes(1);
      expect(inventoryUpdate).not.toHaveBeenCalled();
    });

    it('missing variant → 404 and nothing is written', async () => {
      variantFindById.mockResolvedValue(null);

      await expect(
        service.addItem(
          USER_ID,
          buildAddDto({ variantId: VARIANT_ID, quantity: 2 }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(cartCreateItem).not.toHaveBeenCalled();
    });

    it('inactive variant → 400 and nothing is written', async () => {
      variantFindById.mockResolvedValue(buildVariant({ isActive: false }));

      await expect(
        service.addItem(
          USER_ID,
          buildAddDto({ variantId: VARIANT_ID, quantity: 2 }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(cartCreateItem).not.toHaveBeenCalled();
    });

    it('variant without an inventory row → 404', async () => {
      inventoryFindByVariantId.mockResolvedValue(null);

      await expect(
        service.addItem(
          USER_ID,
          buildAddDto({ variantId: VARIANT_ID, quantity: 2 }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(cartCreateItem).not.toHaveBeenCalled();
    });

    it('unknown user → 404 before any catalogue lookup', async () => {
      userFindById.mockResolvedValue(null);

      await expect(
        service.addItem(
          USER_ID,
          buildAddDto({ variantId: VARIANT_ID, quantity: 2 }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(variantFindById).not.toHaveBeenCalled();
    });

    it('retries the insert as an increment after losing the unique race', async () => {
      cartCreateItem.mockRejectedValueOnce(buildUniqueViolation('CartItem'));
      cartFindItemByCartAndVariant
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(buildCatalog(VARIANT_ID, { quantity: 1 }));
      cartIncrementWithinAvailable.mockResolvedValue(1);
      cartFindItemByIdAndCart.mockResolvedValue(
        buildCatalog(VARIANT_ID, { quantity: 3 }),
      );

      const result = await service.addItem(
        USER_ID,
        buildAddDto({ variantId: VARIANT_ID, quantity: 2 }),
      );

      expect(cartCreateItem).toHaveBeenCalledTimes(1);
      expect(cartIncrementWithinAvailable).toHaveBeenCalledTimes(1);
      expect(result.quantity).toBe(3);
    });

    it('detects the race through the target array as well as the model name', async () => {
      cartCreateItem.mockRejectedValueOnce(
        buildUniqueViolation('Unknown', { target: ['cartId', 'variantId'] }),
      );
      cartFindItemByCartAndVariant
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(buildCatalog(VARIANT_ID, { quantity: 1 }));
      cartIncrementWithinAvailable.mockResolvedValue(1);
      cartFindItemByIdAndCart.mockResolvedValue(
        buildCatalog(VARIANT_ID, { quantity: 3 }),
      );

      await expect(
        service.addItem(
          USER_ID,
          buildAddDto({ variantId: VARIANT_ID, quantity: 2 }),
        ),
      ).resolves.toBeDefined();
      expect(cartIncrementWithinAvailable).toHaveBeenCalledTimes(1);
    });

    it('reports a conflict when the race repeats instead of looping forever', async () => {
      cartCreateItem.mockRejectedValue(buildUniqueViolation('CartItem'));
      cartFindItemByCartAndVariant.mockResolvedValue(null);

      await expect(
        service.addItem(
          USER_ID,
          buildAddDto({ variantId: VARIANT_ID, quantity: 2 }),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(cartCreateItem).toHaveBeenCalledTimes(2);
    });

    it('turns the database stock ceiling into a 409 rather than overselling', async () => {
      cartFindItemByCartAndVariant.mockResolvedValue(
        buildCatalog(VARIANT_ID, { quantity: 2 }),
      );
      cartIncrementWithinAvailable.mockResolvedValue(0);
      cartFindItemByIdAndCart.mockResolvedValue(
        buildCatalog(VARIANT_ID, { quantity: 9 }),
      );

      await expect(
        service.addItem(
          USER_ID,
          buildAddDto({ variantId: VARIANT_ID, quantity: 1 }),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('reports the guarded increment losing a vanished line as 404', async () => {
      cartFindItemByCartAndVariant.mockResolvedValue(
        buildCatalog(VARIANT_ID, { quantity: 2 }),
      );
      cartIncrementWithinAvailable.mockResolvedValue(0);
      cartFindItemByIdAndCart.mockResolvedValue(null);

      await expect(
        service.addItem(
          USER_ID,
          buildAddDto({ variantId: VARIANT_ID, quantity: 1 }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('propagates a non-cart Prisma failure untouched', async () => {
      const failure = new Prisma.PrismaClientKnownRequestError('boom', {
        code: 'P2003',
        clientVersion: '7.10.0',
        meta: { modelName: 'CartItem' },
      });
      cartCreateItem.mockRejectedValue(failure);

      await expect(
        service.addItem(
          USER_ID,
          buildAddDto({ variantId: VARIANT_ID, quantity: 2 }),
        ),
      ).rejects.toBe(failure);
    });

    it('reports a variant deleted under a cart line as a 409', async () => {
      cartCreateItem.mockRejectedValue(buildVariantRestrictViolation());

      await expect(
        service.addItem(
          USER_ID,
          buildAddDto({ variantId: VARIANT_ID, quantity: 2 }),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('never forwards client-supplied identity fields to the insert', async () => {
      const dto = buildAddDto({
        variantId: VARIANT_ID,
        quantity: 2,
      }) as AddCartItemDto & Record<string, unknown>;
      dto.id = 'attacker';
      dto.cartId = OTHER_VARIANT_ID;
      dto.createdAt = new Date();

      await service.addItem(USER_ID, dto);

      const data = cartCreateItem.mock.calls[0][0];
      expect(data.cartId).toBe(CART_ID);
      expect(data).not.toHaveProperty('id');
      expect(data).not.toHaveProperty('createdAt');
    });
  });

  describe('updateItem', () => {
    beforeEach(() => {
      cartFindByUserId.mockResolvedValue(buildCart());
      cartFindItemByIdAndCart.mockResolvedValue(buildCatalog(VARIANT_ID));
      cartUpdateItemQuantity.mockImplementation(
        (itemId: string, quantity: number) =>
          Promise.resolve(buildCatalog(VARIANT_ID, { id: itemId, quantity })),
      );
    });

    it('sets an absolute quantity', async () => {
      const result = await service.updateItem(
        USER_ID,
        ITEM_ID,
        buildUpdateDto({ quantity: 7 }),
      );

      expect(cartUpdateItemQuantity).toHaveBeenCalledWith(ITEM_ID, 7, {
        tx: true,
      });
      expect(result.quantity).toBe(7);
      expect(result.lineTotal).toBe('139.93');
    });

    it('runs the stock read and the write in one transaction', async () => {
      await service.updateItem(
        USER_ID,
        ITEM_ID,
        buildUpdateDto({ quantity: 7 }),
      );

      expect(cartRunInTransaction).toHaveBeenCalledTimes(1);
      expect(inventoryFindByVariantId.mock.calls[0][1]).toEqual({ tx: true });
    });

    it('rejects a quantity above the available stock', async () => {
      await expect(
        service.updateItem(USER_ID, ITEM_ID, buildUpdateDto({ quantity: 11 })),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(cartUpdateItemQuantity).not.toHaveBeenCalled();
    });

    it('a line in another cart → 404 and nothing is written', async () => {
      cartFindItemByIdAndCart.mockResolvedValue(null);

      await expect(
        service.updateItem(USER_ID, ITEM_ID, buildUpdateDto({ quantity: 3 })),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(cartUpdateItemQuantity).not.toHaveBeenCalled();
    });

    it('a user with no cart at all → 404 and no transaction is opened', async () => {
      cartFindByUserId.mockResolvedValue(null);

      await expect(
        service.updateItem(USER_ID, ITEM_ID, buildUpdateDto({ quantity: 3 })),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(cartRunInTransaction).not.toHaveBeenCalled();
    });

    it('a line whose variant lost its inventory row → 404', async () => {
      inventoryFindByVariantId.mockResolvedValue(null);

      await expect(
        service.updateItem(USER_ID, ITEM_ID, buildUpdateDto({ quantity: 3 })),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(cartUpdateItemQuantity).not.toHaveBeenCalled();
    });

    it('unknown user → 404', async () => {
      userFindById.mockResolvedValue(null);

      await expect(
        service.updateItem(USER_ID, ITEM_ID, buildUpdateDto({ quantity: 3 })),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('allows lowering a line whose variant has since been deactivated', async () => {
      cartFindItemByIdAndCart.mockResolvedValue(
        buildCatalog(VARIANT_ID, {
          variant: { ...buildCatalog(VARIANT_ID).variant, isActive: false },
        }),
      );

      await expect(
        service.updateItem(USER_ID, ITEM_ID, buildUpdateDto({ quantity: 1 })),
      ).resolves.toBeDefined();
      expect(cartUpdateItemQuantity).toHaveBeenCalled();
    });

    it('never forwards a cartId smuggled into the dto', async () => {
      const dto = buildUpdateDto({ quantity: 2 }) as UpdateCartItemDto & {
        cartId?: string;
      };
      dto.cartId = 'other-cart';

      await service.updateItem(USER_ID, ITEM_ID, dto);

      expect(cartUpdateItemQuantity.mock.calls[0][0]).toBe(ITEM_ID);
      expect(cartUpdateItemQuantity.mock.calls[0]).toHaveLength(3);
    });
  });

  describe('removeItem', () => {
    beforeEach(() => {
      cartFindByUserId.mockResolvedValue(buildCart());
      cartDeleteItemByIdAndCart.mockResolvedValue(1);
    });

    it('removes the line scoped to the caller cart', async () => {
      await expect(
        service.removeItem(USER_ID, ITEM_ID),
      ).resolves.toBeUndefined();

      expect(cartDeleteItemByIdAndCart).toHaveBeenCalledWith(ITEM_ID, CART_ID);
    });

    it('a line in another cart → 404', async () => {
      cartDeleteItemByIdAndCart.mockResolvedValue(0);

      await expect(service.removeItem(USER_ID, ITEM_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('a user with no cart → 404 without touching any line', async () => {
      cartFindByUserId.mockResolvedValue(null);

      await expect(service.removeItem(USER_ID, ITEM_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(cartDeleteItemByIdAndCart).not.toHaveBeenCalled();
    });

    it('unknown user → 404', async () => {
      userFindById.mockResolvedValue(null);

      await expect(service.removeItem(USER_ID, ITEM_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('clearCart', () => {
    beforeEach(() => {
      cartFindByUserId.mockResolvedValue(buildCart());
      cartDeleteItemsByCart.mockResolvedValue(2);
    });

    it('empties the cart while keeping the cart row', async () => {
      await expect(service.clearCart(USER_ID)).resolves.toBeUndefined();

      expect(cartDeleteItemsByCart).toHaveBeenCalledWith(CART_ID);
    });

    it('is idempotent for a user who has no cart', async () => {
      cartFindByUserId.mockResolvedValue(null);

      await expect(service.clearCart(USER_ID)).resolves.toBeUndefined();
      expect(cartDeleteItemsByCart).not.toHaveBeenCalled();
    });

    it('unknown user → 404 rather than a silent success', async () => {
      userFindById.mockResolvedValue(null);

      await expect(service.clearCart(USER_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(cartDeleteItemsByCart).not.toHaveBeenCalled();
    });

    it('does not reserve or release any inventory', async () => {
      await service.clearCart(USER_ID);

      expect(inventoryFindByVariantId).not.toHaveBeenCalled();
    });
  });
});
