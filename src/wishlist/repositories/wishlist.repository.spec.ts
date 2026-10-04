import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  WishlistRepository,
  type CreateWishlistItemData,
  type WishlistTransactionClient,
} from './wishlist.repository.js';

const WISHLIST_ID = 'wl-1';
const PRODUCT_ID = 'p-1';

const buildWishlistItemData = (
  overrides: Partial<CreateWishlistItemData> = {},
): CreateWishlistItemData => ({
  wishlistId: WISHLIST_ID,
  productId: PRODUCT_ID,
  ...overrides,
});

/**
 * A stand-in for the payload Prisma returns with the product include: the scalar
 * columns plus the joined `product`, its primary `image` and its active `variants`.
 * The repository is exercised on the *shape* it queries and returns, so the fixture
 * carries the same fields the real rows do.
 */
const buildWishlistItem = (overrides: Record<string, unknown> = {}) => ({
  id: 'wi-1',
  wishlistId: WISHLIST_ID,
  productId: PRODUCT_ID,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  product: {
    id: PRODUCT_ID,
    categoryId: 'cat-1',
    name: 'Oversized T-Shirt',
    slug: 'oversized-t-shirt',
    description: null,
    basePrice: '19.99',
    status: 'ACTIVE',
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    images: [
      {
        id: 'img-1',
        productId: PRODUCT_ID,
        imageUrl: 'https://cdn.example.com/front.jpg',
        publicId: 'products/front',
        altText: 'Front of the t-shirt',
        sortOrder: 0,
        isPrimary: true,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ],
    variants: [
      {
        id: 'v-1',
        productId: PRODUCT_ID,
        sku: 'TSHIRT-BLK-M',
        price: '19.99',
        isActive: true,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        options: [
          { id: 'vo-1', optionName: 'Color', optionValue: 'Black' },
          { id: 'vo-2', optionName: 'Size', optionValue: 'M' },
        ],
        inventory: {
          id: 'i-1',
          variantId: 'v-1',
          quantity: 10,
          reservedQuantity: 2,
        },
      },
    ],
  },
  ...overrides,
});

const buildWishlist = (overrides: Record<string, unknown> = {}) => ({
  id: WISHLIST_ID,
  userId: 'u-1',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  items: [buildWishlistItem()],
  ...overrides,
});

describe('WishlistRepository', () => {
  let repository: WishlistRepository;
  let wishlistFindUnique: ReturnType<typeof vi.fn>;
  let wishlistCreate: ReturnType<typeof vi.fn>;
  let wishlistItemFindUnique: ReturnType<typeof vi.fn>;
  let wishlistItemCreate: ReturnType<typeof vi.fn>;
  let wishlistItemDeleteMany: ReturnType<typeof vi.fn>;
  let transaction: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    wishlistFindUnique = vi.fn();
    wishlistCreate = vi.fn();
    wishlistItemFindUnique = vi.fn();
    wishlistItemCreate = vi.fn();
    wishlistItemDeleteMany = vi.fn();
    transaction = vi.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WishlistRepository,
        {
          provide: PrismaService,
          useValue: {
            wishlist: {
              findUnique: wishlistFindUnique,
              create: wishlistCreate,
            },
            wishlistItem: {
              findUnique: wishlistItemFindUnique,
              create: wishlistItemCreate,
              deleteMany: wishlistItemDeleteMany,
            },
            $transaction: transaction,
          },
        },
      ],
    }).compile();

    repository = module.get<WishlistRepository>(WishlistRepository);
  });

  it('should be defined', () => {
    expect(repository).toBeDefined();
  });

  describe('runInTransaction', () => {
    it('delegates to $transaction and forwards its result', async () => {
      const expected = buildWishlist();
      transaction.mockImplementation(
        (work: (tx: unknown) => Promise<unknown>) => work({ tx: true }),
      );

      await expect(
        repository.runInTransaction(vi.fn().mockResolvedValue(expected)),
      ).resolves.toBe(expected);

      const work = transaction.mock.calls[0][0];
      expect(work).toHaveBeenCalledWith({ tx: true });
    });
  });

  describe('findByUserId', () => {
    it('addresses the wishlist by its unique owner and hydrates the items', async () => {
      const wishlist = buildWishlist();
      wishlistFindUnique.mockResolvedValue(wishlist);

      await expect(repository.findByUserId('u-1')).resolves.toBe(wishlist);

      const query = wishlistFindUnique.mock.calls[0][0];
      expect(query.where).toEqual({ userId: 'u-1' });
      expect(query.include.items.orderBy).toEqual([
        { createdAt: 'asc' },
        { id: 'asc' },
      ]);
    });

    it('asks for one best image and the active variants only', async () => {
      wishlistFindUnique.mockResolvedValue(buildWishlist());

      await repository.findByUserId('u-1');

      const product =
        wishlistFindUnique.mock.calls[0][0].include.items.include.product;

      expect(product.include.images).toEqual({
        orderBy: [
          { isPrimary: 'desc' },
          { sortOrder: 'asc' },
          { createdAt: 'asc' },
        ],
        take: 1,
      });
      expect(product.include.variants.where).toEqual({ isActive: true });
      expect(product.include.variants.include).toEqual({
        options: { orderBy: [{ optionName: 'asc' }, { id: 'asc' }] },
        inventory: true,
      });
    });

    it('returns null when the user has no wishlist', async () => {
      wishlistFindUnique.mockResolvedValue(null);

      await expect(repository.findByUserId('u-1')).resolves.toBeNull();
    });

    it('uses the transaction client when one is supplied', async () => {
      const txFindUnique = vi.fn().mockResolvedValue(buildWishlist());

      await repository.findByUserId('u-1', {
        wishlist: { findUnique: txFindUnique },
      } as unknown as WishlistTransactionClient);

      expect(txFindUnique).toHaveBeenCalledTimes(1);
      expect(wishlistFindUnique).not.toHaveBeenCalled();
    });
  });

  describe('createForUser', () => {
    it('writes only the user id', async () => {
      const wishlist = buildWishlist({ items: [] });
      wishlistCreate.mockResolvedValue(wishlist);

      await expect(repository.createForUser('u-1')).resolves.toBe(wishlist);

      expect(wishlistCreate.mock.calls[0][0].data).toEqual({ userId: 'u-1' });
    });
  });

  describe('findItemByWishlistAndProduct', () => {
    it('addresses the entry through the composite unique key', async () => {
      const item = buildWishlistItem();
      wishlistItemFindUnique.mockResolvedValue(item);

      await expect(
        repository.findItemByWishlistAndProduct(WISHLIST_ID, PRODUCT_ID),
      ).resolves.toBe(item);

      expect(wishlistItemFindUnique.mock.calls[0][0].where).toEqual({
        wishlistId_productId: {
          wishlistId: WISHLIST_ID,
          productId: PRODUCT_ID,
        },
      });
    });

    it('returns null when the product is not saved on that wishlist', async () => {
      wishlistItemFindUnique.mockResolvedValue(null);

      await expect(
        repository.findItemByWishlistAndProduct(WISHLIST_ID, 'other'),
      ).resolves.toBeNull();
    });

    it('uses the transaction client when one is supplied', async () => {
      const txFindUnique = vi.fn().mockResolvedValue(buildWishlistItem());

      await repository.findItemByWishlistAndProduct(WISHLIST_ID, PRODUCT_ID, {
        wishlistItem: { findUnique: txFindUnique },
      } as unknown as WishlistTransactionClient);

      expect(txFindUnique).toHaveBeenCalledTimes(1);
      expect(wishlistItemFindUnique).not.toHaveBeenCalled();
    });
  });

  describe('findItemByIdAndWishlist', () => {
    it('scopes the lookup to the wishlist in the query itself', async () => {
      wishlistItemFindUnique.mockResolvedValue(buildWishlistItem());

      await repository.findItemByIdAndWishlist('wi-1', WISHLIST_ID);

      expect(wishlistItemFindUnique.mock.calls[0][0].where).toEqual({
        id: 'wi-1',
        wishlistId: WISHLIST_ID,
      });
    });

    it('cannot see an entry belonging to another wishlist', async () => {
      wishlistItemFindUnique.mockResolvedValue(null);

      await expect(
        repository.findItemByIdAndWishlist('wi-1', 'other-wishlist'),
      ).resolves.toBeNull();
    });
  });

  describe('createItem', () => {
    it('forwards exactly the writable columns', async () => {
      const item = buildWishlistItem();
      wishlistItemCreate.mockResolvedValue(item);

      await expect(
        repository.createItem(buildWishlistItemData()),
      ).resolves.toBe(item);

      const query = wishlistItemCreate.mock.calls[0][0];
      expect(query.data).toEqual({
        wishlistId: WISHLIST_ID,
        productId: PRODUCT_ID,
      });
      expect(query.data).not.toHaveProperty('id');
      expect(query.data).not.toHaveProperty('createdAt');
    });

    it('uses the transaction client when one is supplied', async () => {
      const txCreate = vi.fn().mockResolvedValue(buildWishlistItem());

      await repository.createItem(buildWishlistItemData(), {
        wishlistItem: { create: txCreate },
      } as unknown as WishlistTransactionClient);

      expect(txCreate).toHaveBeenCalledTimes(1);
      expect(wishlistItemCreate).not.toHaveBeenCalled();
    });
  });

  describe('deletes', () => {
    it('deleteItemByIdAndWishlist scopes the removal to the owner', async () => {
      wishlistItemDeleteMany.mockResolvedValue({ count: 1 });

      await expect(
        repository.deleteItemByIdAndWishlist('wi-1', WISHLIST_ID),
      ).resolves.toBe(1);

      expect(wishlistItemDeleteMany).toHaveBeenCalledWith({
        where: { id: 'wi-1', wishlistId: WISHLIST_ID },
      });
    });

    it('deleteItemByIdAndWishlist reports an entry it did not remove', async () => {
      wishlistItemDeleteMany.mockResolvedValue({ count: 0 });

      await expect(
        repository.deleteItemByIdAndWishlist('wi-1', 'other-wishlist'),
      ).resolves.toBe(0);
    });

    it('deleteItemsByWishlist clears the wishlist but never the wishlist row', async () => {
      wishlistItemDeleteMany.mockResolvedValue({ count: 4 });

      await expect(repository.deleteItemsByWishlist(WISHLIST_ID)).resolves.toBe(
        4,
      );

      expect(wishlistItemDeleteMany).toHaveBeenCalledWith({
        where: { wishlistId: WISHLIST_ID },
      });
      expect(wishlistItemDeleteMany.mock.calls[0][0]).not.toHaveProperty('id');
    });

    it('deleteItemsByWishlist uses the transaction client when one is supplied', async () => {
      const txDeleteMany = vi.fn().mockResolvedValue({ count: 1 });

      await repository.deleteItemsByWishlist(WISHLIST_ID, {
        wishlistItem: { deleteMany: txDeleteMany },
      } as unknown as WishlistTransactionClient);

      expect(txDeleteMany).toHaveBeenCalledTimes(1);
      expect(wishlistItemDeleteMany).not.toHaveBeenCalled();
    });
  });
});
