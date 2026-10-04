import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  CartRepository,
  type CartTransactionClient,
  type CreateCartItemData,
} from './cart.repository.js';

const CART_ID = 'c-1';
const VARIANT_ID = 'v-1';

const buildCartItemData = (
  overrides: Partial<CreateCartItemData> = {},
): CreateCartItemData => ({
  cartId: CART_ID,
  variantId: VARIANT_ID,
  quantity: 2,
  ...overrides,
});

/**
 * A stand-in for the payload Prisma returns with the catalog include: the scalar
 * columns plus the joined `variant`, `product`, `inventory` and `options`. The
 * repository is exercised on the *shape* it queries and returns, so the fixtures
 * carry the same fields the real rows do.
 */
const buildCartItemCatalog = (overrides: Record<string, unknown> = {}) => ({
  id: 'ci-1',
  cartId: CART_ID,
  variantId: VARIANT_ID,
  quantity: 2,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  variant: {
    id: VARIANT_ID,
    productId: 'p-1',
    sku: 'TSHIRT-BLK-M',
    price: '19.99',
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    options: [],
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
    inventory: { id: 'i-1', quantity: 10, reservedQuantity: 2 },
  },
  ...overrides,
});

const buildCart = (overrides: Record<string, unknown> = {}) => ({
  id: CART_ID,
  userId: 'u-1',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  items: [buildCartItemCatalog()],
  ...overrides,
});

describe('CartRepository', () => {
  let repository: CartRepository;
  let cartFindUnique: ReturnType<typeof vi.fn>;
  let cartCreate: ReturnType<typeof vi.fn>;
  let cartItemFindUnique: ReturnType<typeof vi.fn>;
  let cartItemCreate: ReturnType<typeof vi.fn>;
  let cartItemUpdateMany: ReturnType<typeof vi.fn>;
  let cartItemUpdate: ReturnType<typeof vi.fn>;
  let cartItemDeleteMany: ReturnType<typeof vi.fn>;
  let transaction: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    cartFindUnique = vi.fn();
    cartCreate = vi.fn();
    cartItemFindUnique = vi.fn();
    cartItemCreate = vi.fn();
    cartItemUpdateMany = vi.fn();
    cartItemUpdate = vi.fn();
    cartItemDeleteMany = vi.fn();
    transaction = vi.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CartRepository,
        {
          provide: PrismaService,
          useValue: {
            cart: { findUnique: cartFindUnique, create: cartCreate },
            cartItem: {
              findUnique: cartItemFindUnique,
              create: cartItemCreate,
              updateMany: cartItemUpdateMany,
              update: cartItemUpdate,
              deleteMany: cartItemDeleteMany,
            },
            $transaction: transaction,
          },
        },
      ],
    }).compile();

    repository = module.get<CartRepository>(CartRepository);
  });

  it('should be defined', () => {
    expect(repository).toBeDefined();
  });

  describe('runInTransaction', () => {
    it('delegates to $transaction and forwards its result', async () => {
      const expected = buildCart();
      transaction.mockImplementation(
        (work: (tx: unknown) => Promise<unknown>) => work({ tx: true }),
      );
      const work = vi.fn().mockResolvedValue(expected);

      await expect(repository.runInTransaction(work)).resolves.toBe(expected);
      expect(transaction).toHaveBeenCalledWith(work);
      expect(work).toHaveBeenCalledWith({ tx: true });
    });
  });

  describe('findByUserId', () => {
    it('addresses the cart by its unique owner and hydrates the lines', async () => {
      const cart = buildCart();
      cartFindUnique.mockResolvedValue(cart);

      await expect(repository.findByUserId('u-1')).resolves.toBe(cart);

      const query = cartFindUnique.mock.calls[0][0];
      expect(query.where).toEqual({ userId: 'u-1' });
      expect(query.include.items.include.variant.include).toEqual({
        options: { orderBy: [{ optionName: 'asc' }, { id: 'asc' }] },
        product: true,
        inventory: true,
      });
    });

    it('returns null when the user has no cart', async () => {
      cartFindUnique.mockResolvedValue(null);

      await expect(repository.findByUserId('u-1')).resolves.toBeNull();
    });

    it('uses the transaction client when one is supplied', async () => {
      const txFindUnique = vi.fn().mockResolvedValue(buildCart());

      await repository.findByUserId(
        'u-1',
        { cart: { findUnique: txFindUnique } } as unknown as CartTransactionClient,
      );

      expect(txFindUnique).toHaveBeenCalledTimes(1);
      expect(cartFindUnique).not.toHaveBeenCalled();
    });
  });

  describe('createForUser', () => {
    it('writes only the user id', async () => {
      const cart = buildCart({ items: [] });
      cartCreate.mockResolvedValue(cart);

      await expect(repository.createForUser('u-1')).resolves.toBe(cart);

      expect(cartCreate.mock.calls[0][0].data).toEqual({ userId: 'u-1' });
    });
  });

  describe('findItemByCartAndVariant', () => {
    it('addresses the line through the composite unique key', async () => {
      const item = buildCartItemCatalog();
      cartItemFindUnique.mockResolvedValue(item);

      await expect(
        repository.findItemByCartAndVariant(CART_ID, VARIANT_ID),
      ).resolves.toBe(item);

      expect(cartItemFindUnique.mock.calls[0][0].where).toEqual({
        cartId_variantId: { cartId: CART_ID, variantId: VARIANT_ID },
      });
    });

    it('returns null when the cart holds no line for that variant', async () => {
      cartItemFindUnique.mockResolvedValue(null);

      await expect(
        repository.findItemByCartAndVariant(CART_ID, VARIANT_ID),
      ).resolves.toBeNull();
    });
  });

  describe('findItemByIdAndCart', () => {
    it('scopes the lookup to the cart in the query itself', async () => {
      cartItemFindUnique.mockResolvedValue(buildCartItemCatalog());

      await repository.findItemByIdAndCart('ci-1', CART_ID);

      expect(cartItemFindUnique.mock.calls[0][0].where).toEqual({
        id: 'ci-1',
        cartId: CART_ID,
      });
    });
  });

  describe('createItem', () => {
    it('forwards exactly the writable columns', async () => {
      const item = buildCartItemCatalog();
      cartItemCreate.mockResolvedValue(item);

      await expect(
        repository.createItem(buildCartItemData()),
      ).resolves.toBe(item);

      const query = cartItemCreate.mock.calls[0][0];
      expect(query.data).toEqual({
        cartId: CART_ID,
        variantId: VARIANT_ID,
        quantity: 2,
      });
      expect(query.data).not.toHaveProperty('id');
      expect(query.data).not.toHaveProperty('createdAt');
      expect(query.data).not.toHaveProperty('updatedAt');
    });

    it('uses the transaction client when one is supplied', async () => {
      const txCreate = vi.fn().mockResolvedValue(buildCartItemCatalog());

      await repository.createItem(
        buildCartItemData(),
        { cartItem: { create: txCreate } } as unknown as CartTransactionClient,
      );

      expect(txCreate).toHaveBeenCalledTimes(1);
      expect(cartItemCreate).not.toHaveBeenCalled();
    });
  });

  describe('incrementItemQuantityWithinAvailable', () => {
    it('guards the increment with the stock ceiling in one statement', async () => {
      cartItemUpdateMany.mockResolvedValue({ count: 1 });

      await expect(
        repository.incrementItemQuantityWithinAvailable('ci-1', 2, 5),
      ).resolves.toBe(1);

      expect(cartItemUpdateMany).toHaveBeenCalledWith({
        where: { id: 'ci-1', quantity: { lte: 3 } },
        data: { quantity: { increment: 2 } },
      });
    });

    it('reports the rejected case as zero rows', async () => {
      cartItemUpdateMany.mockResolvedValue({ count: 0 });

      await expect(
        repository.incrementItemQuantityWithinAvailable('ci-1', 2, 5),
      ).resolves.toBe(0);
    });

    it('computes a negative ceiling when the request cannot fit', async () => {
      cartItemUpdateMany.mockResolvedValue({ count: 0 });

      await repository.incrementItemQuantityWithinAvailable('ci-1', 9, 5);

      expect(cartItemUpdateMany.mock.calls[0][0].where.quantity).toEqual({
        lte: -4,
      });
    });
  });

  describe('updateItemQuantity', () => {
    it('sets an absolute quantity addressed by line id', async () => {
      const item = buildCartItemCatalog({ quantity: 7 });
      cartItemUpdate.mockResolvedValue(item);

      await expect(
        repository.updateItemQuantity('ci-1', 7),
      ).resolves.toBe(item);

      expect(cartItemUpdate.mock.calls[0][0]).toMatchObject({
        where: { id: 'ci-1' },
        data: { quantity: 7 },
      });
    });
  });

  describe('deletes', () => {
    it('deleteItemByIdAndCart scopes the removal to the owner', async () => {
      cartItemDeleteMany.mockResolvedValue({ count: 1 });

      await expect(
        repository.deleteItemByIdAndCart('ci-1', CART_ID),
      ).resolves.toBe(1);

      expect(cartItemDeleteMany).toHaveBeenCalledWith({
        where: { id: 'ci-1', cartId: CART_ID },
      });
    });

    it('deleteItemByIdAndCart reports a line it did not remove', async () => {
      cartItemDeleteMany.mockResolvedValue({ count: 0 });

      await expect(
        repository.deleteItemByIdAndCart('ci-1', 'other-cart'),
      ).resolves.toBe(0);
    });

    it('deleteItemsByCart clears the cart but never the cart row', async () => {
      cartItemDeleteMany.mockResolvedValue({ count: 3 });

      await expect(repository.deleteItemsByCart(CART_ID)).resolves.toBe(3);

      expect(cartItemDeleteMany).toHaveBeenCalledWith({
        where: { cartId: CART_ID },
      });
      expect(cartItemDeleteMany.mock.calls[0][0]).not.toHaveProperty(
        'id',
      );
    });

    it('deleteItemsByCart uses the transaction client when one is supplied', async () => {
      const txDeleteMany = vi.fn().mockResolvedValue({ count: 1 });

      await repository.deleteItemsByCart(
        CART_ID,
        { cartItem: { deleteMany: txDeleteMany } } as unknown as CartTransactionClient,
      );

      expect(txDeleteMany).toHaveBeenCalledTimes(1);
      expect(cartItemDeleteMany).not.toHaveBeenCalled();
    });
  });
});