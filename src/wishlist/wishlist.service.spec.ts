import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '../generated/prisma/client.js';
import { ProductsRepository } from '../products/repositories/products.repository.js';
import { UsersRepository } from '../users/repositories/users.repository.js';
import { AddWishlistItemDto } from './dto/add-wishlist-item.dto.js';
import { WishlistService } from './wishlist.service.js';
import { WishlistRepository } from './repositories/wishlist.repository.js';

const USER_ID = 'a1b2c3d4-e5f6-4f70-8a9b-0c1d2e3f4a5b';
const WISHLIST_ID = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f';
const ITEM_ID = 'd2e3f4a5-b6c7-4d8e-9f0a-1b2c3d4e5f60';
const PRODUCT_ID = 'e3f4a5b6-c7d8-4e9f-8a0b-2c3d4e5f6071';

const buildAddDto = (
  overrides: Partial<AddWishlistItemDto> = {},
): AddWishlistItemDto => Object.assign(new AddWishlistItemDto(), overrides);

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

const buildProduct = (overrides: Record<string, unknown> = {}) => ({
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
  ...overrides,
});

const buildVariant = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
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
  inventory: { id: 'i-1', variantId: 'v-1', quantity: 10, reservedQuantity: 2 },
  ...overrides,
});

const buildItem = (overrides: Record<string, unknown> = {}) => ({
  id: ITEM_ID,
  wishlistId: WISHLIST_ID,
  productId: PRODUCT_ID,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  product: {
    ...buildProduct(),
    images: [],
    variants: [buildVariant()],
  },
  ...overrides,
});

const buildWishlist = (overrides: Record<string, unknown> = {}) => ({
  id: WISHLIST_ID,
  userId: USER_ID,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  items: [],
  ...overrides,
});

/**
 * The unique violation a duplicate save produces under the driver adapter: no
 * `meta.target`, only the Postgres constraint inside `driverAdapterError`. The
 * service has to recognise it from the model name, so the fixture mirrors what the
 * adapter actually reports rather than the engine-native shape.
 */
const buildItemUniqueViolation = (meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '7.10.0',
    meta: {
      modelName: 'WishlistItem',
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          originalCode: '23505',
          kind: 'UniqueConstraintViolation',
          constraint: {
            index: 'wishlist_items_wishlist_id_product_id_key',
          },
          table: 'wishlist_items',
        },
      },
      ...meta,
    },
  });

const buildWishlistUniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '7.10.0',
    meta: {
      modelName: 'Wishlist',
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          originalCode: '23505',
          kind: 'UniqueConstraintViolation',
          constraint: { index: 'wishlists_user_id_key' },
          table: 'wishlists',
        },
      },
    },
  });

const buildProductRestrictViolation = () =>
  new Prisma.PrismaClientKnownRequestError('Foreign key constraint failed', {
    code: 'P2003',
    clientVersion: '7.10.0',
    meta: {
      modelName: 'WishlistItem',
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          originalCode: '23503',
          kind: 'ForeignKeyViolation',
          constraint: { index: 'wishlist_items_product_id_fkey' },
          table: 'wishlist_items',
        },
      },
    },
  });

describe('WishlistService', () => {
  let service: WishlistService;
  let wishlistFindByUserId: ReturnType<typeof vi.fn>;
  let wishlistCreateForUser: ReturnType<typeof vi.fn>;
  let wishlistFindItemByWishlistAndProduct: ReturnType<typeof vi.fn>;
  let wishlistFindItemByIdAndWishlist: ReturnType<typeof vi.fn>;
  let wishlistCreateItem: ReturnType<typeof vi.fn>;
  let wishlistDeleteItemByIdAndWishlist: ReturnType<typeof vi.fn>;
  let wishlistDeleteItemsByWishlist: ReturnType<typeof vi.fn>;
  let wishlistRunInTransaction: ReturnType<typeof vi.fn>;
  let productFindById: ReturnType<typeof vi.fn>;
  let userFindById: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    wishlistFindByUserId = vi.fn();
    wishlistCreateForUser = vi.fn();
    wishlistFindItemByWishlistAndProduct = vi.fn();
    wishlistFindItemByIdAndWishlist = vi.fn();
    wishlistCreateItem = vi.fn();
    wishlistDeleteItemByIdAndWishlist = vi.fn();
    wishlistDeleteItemsByWishlist = vi.fn();
    wishlistRunInTransaction = vi
      .fn()
      .mockImplementation((work: (tx: unknown) => Promise<unknown>) =>
        work({ tx: true }),
      );
    productFindById = vi.fn();
    userFindById = vi.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WishlistService,
        {
          provide: WishlistRepository,
          useValue: {
            findByUserId: wishlistFindByUserId,
            createForUser: wishlistCreateForUser,
            findItemByWishlistAndProduct: wishlistFindItemByWishlistAndProduct,
            findItemByIdAndWishlist: wishlistFindItemByIdAndWishlist,
            createItem: wishlistCreateItem,
            deleteItemByIdAndWishlist: wishlistDeleteItemByIdAndWishlist,
            deleteItemsByWishlist: wishlistDeleteItemsByWishlist,
            runInTransaction: wishlistRunInTransaction,
          },
        },
        {
          provide: ProductsRepository,
          useValue: { findById: productFindById },
        },
        { provide: UsersRepository, useValue: { findById: userFindById } },
      ],
    }).compile();

    service = module.get<WishlistService>(WishlistService);

    userFindById.mockResolvedValue(buildUser());
    productFindById.mockResolvedValue(buildProduct());
    wishlistFindByUserId.mockResolvedValue(buildWishlist());
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('findWishlist', () => {
    it('returns the existing wishlist with its items', async () => {
      wishlistFindByUserId.mockResolvedValue(
        buildWishlist({ items: [buildItem()] }),
      );

      const result = await service.findWishlist(USER_ID);

      expect(result.id).toBe(WISHLIST_ID);
      expect(result.userId).toBe(USER_ID);
      expect(result.items).toHaveLength(1);
      expect(result.itemCount).toBe(1);
      expect(result.items[0].product.name).toBe('Oversized T-Shirt');
    });

    it('creates the wishlist on first read', async () => {
      wishlistFindByUserId.mockResolvedValue(null);
      wishlistCreateForUser.mockResolvedValue(buildWishlist());

      const result = await service.findWishlist(USER_ID);

      expect(wishlistCreateForUser).toHaveBeenCalledWith(USER_ID);
      expect(result.items).toEqual([]);
      expect(result.itemCount).toBe(0);
    });

    it('re-reads instead of surfacing a concurrent first-wishlist conflict', async () => {
      const winner = buildWishlist();
      wishlistFindByUserId
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(winner);
      wishlistCreateForUser.mockRejectedValue(buildWishlistUniqueViolation());

      await expect(service.findWishlist(USER_ID)).resolves.toMatchObject({
        id: WISHLIST_ID,
      });
      expect(wishlistCreateForUser).toHaveBeenCalledTimes(1);
    });

    it('rethrows a wishlist conflict the re-read cannot resolve', async () => {
      const error = buildWishlistUniqueViolation();
      wishlistFindByUserId.mockResolvedValue(null);
      wishlistCreateForUser.mockRejectedValue(error);

      await expect(service.findWishlist(USER_ID)).rejects.toBe(error);
    });

    it('rejects an unknown user before touching the wishlist', async () => {
      userFindById.mockResolvedValue(null);

      await expect(service.findWishlist(USER_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(wishlistFindByUserId).not.toHaveBeenCalled();
    });
  });

  describe('addItem', () => {
    it('creates the wishlist on the very first save', async () => {
      wishlistFindByUserId.mockResolvedValue(null);
      wishlistCreateForUser.mockResolvedValue(buildWishlist());
      wishlistFindItemByWishlistAndProduct.mockResolvedValue(null);
      wishlistCreateItem.mockResolvedValue(buildItem());

      const result = await service.addItem(
        USER_ID,
        buildAddDto({ productId: PRODUCT_ID }),
      );

      expect(wishlistCreateForUser).toHaveBeenCalledWith(USER_ID);
      expect(result.id).toBe(ITEM_ID);
      expect(result.productId).toBe(PRODUCT_ID);
    });

    it('writes both foreign keys from the resolved wishlist, not the body', async () => {
      wishlistFindItemByWishlistAndProduct.mockResolvedValue(null);
      wishlistCreateItem.mockResolvedValue(buildItem());

      await service.addItem(USER_ID, buildAddDto({ productId: PRODUCT_ID }));

      expect(wishlistCreateItem).toHaveBeenCalledWith(
        { wishlistId: WISHLIST_ID, productId: PRODUCT_ID },
        { tx: true },
      );
    });

    it('returns the existing entry instead of a second row when already saved', async () => {
      wishlistFindItemByWishlistAndProduct.mockResolvedValue(buildItem());

      const result = await service.addItem(
        USER_ID,
        buildAddDto({ productId: PRODUCT_ID }),
      );

      expect(result.id).toBe(ITEM_ID);
      expect(wishlistCreateItem).not.toHaveBeenCalled();
    });

    it('rejects a product that does not exist', async () => {
      productFindById.mockResolvedValue(null);

      await expect(
        service.addItem(USER_ID, buildAddDto({ productId: 'missing' })),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(wishlistCreateForUser).not.toHaveBeenCalled();
    });

    it('rejects an unknown user', async () => {
      userFindById.mockResolvedValue(null);

      await expect(
        service.addItem(USER_ID, buildAddDto({ productId: PRODUCT_ID })),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(productFindById).not.toHaveBeenCalled();
    });

    it('saves an inactive product rather than refusing it', async () => {
      productFindById.mockResolvedValue(
        buildProduct({ isActive: false, status: 'ARCHIVED' }),
      );
      wishlistFindItemByWishlistAndProduct.mockResolvedValue(null);
      wishlistCreateItem.mockResolvedValue(
        buildItem({
          product: {
            ...buildProduct({ isActive: false, status: 'ARCHIVED' }),
            images: [],
            variants: [],
          },
        }),
      );

      const result = await service.addItem(
        USER_ID,
        buildAddDto({ productId: PRODUCT_ID }),
      );

      expect(wishlistCreateItem).toHaveBeenCalled();
      expect(result.product.isActive).toBe(false);
      expect(result.product.status).toBe('ARCHIVED');
    });

    it('retries a duplicate save as a lookup and returns the winner row', async () => {
      const winner = buildItem({ id: 'winner-row' });
      wishlistFindItemByWishlistAndProduct
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(winner);
      wishlistCreateItem.mockRejectedValue(buildItemUniqueViolation());

      const result = await service.addItem(
        USER_ID,
        buildAddDto({ productId: PRODUCT_ID }),
      );

      expect(result.id).toBe('winner-row');
      expect(wishlistCreateItem).toHaveBeenCalledTimes(1);
    });

    it('retries at most once', async () => {
      wishlistFindItemByWishlistAndProduct.mockResolvedValue(null);
      wishlistCreateItem.mockRejectedValue(buildItemUniqueViolation());

      await expect(
        service.addItem(USER_ID, buildAddDto({ productId: PRODUCT_ID })),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(wishlistCreateItem).toHaveBeenCalledTimes(2);
    });

    it('recognises an engine-native target instead of only the adapter shape', async () => {
      wishlistFindItemByWishlistAndProduct.mockResolvedValue(null);
      wishlistCreateItem.mockRejectedValue(
        buildItemUniqueViolation({
          modelName: undefined,
          target: ['wishlistId', 'productId'],
        }),
      );

      await expect(
        service.addItem(USER_ID, buildAddDto({ productId: PRODUCT_ID })),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('reports a product deleted underneath the list as a conflict', async () => {
      wishlistFindItemByWishlistAndProduct.mockResolvedValue(null);
      wishlistCreateItem.mockRejectedValue(buildProductRestrictViolation());

      await expect(
        service.addItem(USER_ID, buildAddDto({ productId: PRODUCT_ID })),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('does not launder an unrelated database fault into a 4xx', async () => {
      const error = new Error('connection terminated');
      wishlistFindItemByWishlistAndProduct.mockResolvedValue(null);
      wishlistCreateItem.mockRejectedValue(error);

      await expect(
        service.addItem(USER_ID, buildAddDto({ productId: PRODUCT_ID })),
      ).rejects.toBe(error);
    });

    it('reports the current product, not a snapshot', async () => {
      const renamed = buildItem({
        product: {
          ...buildProduct({ name: 'Renamed', basePrice: '24.50' }),
          images: [],
          variants: [buildVariant({ price: '24.50' })],
        },
      });
      wishlistFindItemByWishlistAndProduct.mockResolvedValue(renamed);

      const result = await service.addItem(
        USER_ID,
        buildAddDto({ productId: PRODUCT_ID }),
      );

      expect(result.product.name).toBe('Renamed');
      expect(result.product.basePrice).toBe('24.50');
      expect(result.product.priceRange).toEqual({ min: '24.50', max: '24.50' });
      expect(result.product.inStock).toBe(true);
    });
  });

  describe('removeItem', () => {
    it('removes the entry from the caller wishlist only', async () => {
      wishlistDeleteItemByIdAndWishlist.mockResolvedValue(1);

      await expect(
        service.removeItem(USER_ID, ITEM_ID),
      ).resolves.toBeUndefined();

      expect(wishlistDeleteItemByIdAndWishlist).toHaveBeenCalledWith(
        ITEM_ID,
        WISHLIST_ID,
      );
    });

    it('answers 404 when the entry belongs to another wishlist', async () => {
      wishlistDeleteItemByIdAndWishlist.mockResolvedValue(0);

      await expect(service.removeItem(USER_ID, ITEM_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('answers 404 when the caller has no wishlist yet', async () => {
      wishlistFindByUserId.mockResolvedValue(null);

      await expect(service.removeItem(USER_ID, ITEM_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(wishlistDeleteItemByIdAndWishlist).not.toHaveBeenCalled();
    });

    it('never creates a wishlist as a side effect', async () => {
      wishlistFindByUserId.mockResolvedValue(null);

      await expect(service.removeItem(USER_ID, ITEM_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(wishlistCreateForUser).not.toHaveBeenCalled();
    });

    it('rejects an unknown user', async () => {
      userFindById.mockResolvedValue(null);

      await expect(service.removeItem(USER_ID, ITEM_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(wishlistFindByUserId).not.toHaveBeenCalled();
    });
  });

  describe('clearWishlist', () => {
    it('empties the wishlist but keeps the row', async () => {
      wishlistDeleteItemsByWishlist.mockResolvedValue(3);

      await expect(service.clearWishlist(USER_ID)).resolves.toBeUndefined();

      expect(wishlistDeleteItemsByWishlist).toHaveBeenCalledWith(WISHLIST_ID);
    });

    it('is a no-op for a user who has no wishlist', async () => {
      wishlistFindByUserId.mockResolvedValue(null);

      await expect(service.clearWishlist(USER_ID)).resolves.toBeUndefined();

      expect(wishlistDeleteItemsByWishlist).not.toHaveBeenCalled();
      expect(wishlistCreateForUser).not.toHaveBeenCalled();
    });

    it('is idempotent when repeated on an already empty wishlist', async () => {
      wishlistDeleteItemsByWishlist
        .mockResolvedValueOnce(2)
        .mockResolvedValue(0);

      await expect(service.clearWishlist(USER_ID)).resolves.toBeUndefined();
      await expect(service.clearWishlist(USER_ID)).resolves.toBeUndefined();

      expect(wishlistDeleteItemsByWishlist).toHaveBeenCalledTimes(2);
    });

    it('rejects an unknown user', async () => {
      userFindById.mockResolvedValue(null);

      await expect(service.clearWishlist(USER_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(wishlistFindByUserId).not.toHaveBeenCalled();
    });
  });

  describe('response mapping', () => {
    it('never exposes the user row behind the wishlist', async () => {
      wishlistFindByUserId.mockResolvedValue(
        buildWishlist({ items: [buildItem()] }),
      );

      const result = await service.findWishlist(USER_ID);

      expect(JSON.stringify(result)).not.toContain('passwordHash');
      expect(Object.keys(result).sort()).toEqual([
        'createdAt',
        'id',
        'itemCount',
        'items',
        'updatedAt',
        'userId',
      ]);
    });

    it('exposes exactly the agreed item keys', async () => {
      wishlistFindByUserId.mockResolvedValue(
        buildWishlist({ items: [buildItem()] }),
      );

      const result = await service.findWishlist(USER_ID);

      expect(Object.keys(result.items[0]).sort()).toEqual([
        'createdAt',
        'id',
        'product',
        'productId',
        'wishlistId',
      ]);
    });

    it('reports the image the query chose, or null when there is none', async () => {
      wishlistFindItemByWishlistAndProduct.mockResolvedValue(
        buildItem({
          product: {
            ...buildProduct(),
            images: [
              {
                imageUrl: 'https://cdn.example.com/front.jpg',
                altText: 'Front',
              },
            ],
            variants: [],
          },
        }),
      );

      const withImage = await service.addItem(
        USER_ID,
        buildAddDto({ productId: PRODUCT_ID }),
      );
      expect(withImage.product.image).toEqual({
        imageUrl: 'https://cdn.example.com/front.jpg',
        altText: 'Front',
      });

      wishlistFindItemByWishlistAndProduct.mockResolvedValue(buildItem());
      const withoutImage = await service.addItem(
        USER_ID,
        buildAddDto({ productId: PRODUCT_ID }),
      );
      expect(withoutImage.product.image).toBeNull();
    });

    it('reports no price range and no stock for a product with no active variant', async () => {
      wishlistFindItemByWishlistAndProduct.mockResolvedValue(
        buildItem({
          product: { ...buildProduct(), images: [], variants: [] },
        }),
      );

      const result = await service.addItem(
        USER_ID,
        buildAddDto({ productId: PRODUCT_ID }),
      );

      expect(result.product.priceRange).toBeNull();
      expect(result.product.inStock).toBe(false);
      expect(result.product.variants).toEqual([]);
    });

    it('reports a variant with no inventory row as not stocked', async () => {
      wishlistFindItemByWishlistAndProduct.mockResolvedValue(
        buildItem({
          product: {
            ...buildProduct(),
            images: [],
            variants: [buildVariant({ inventory: null })],
          },
        }),
      );

      const result = await service.addItem(
        USER_ID,
        buildAddDto({ productId: PRODUCT_ID }),
      );

      expect(result.product.variants[0].available).toBeNull();
      expect(result.product.inStock).toBe(false);
    });

    it('reports a variant whose stock is fully reserved as not stocked', async () => {
      wishlistFindItemByWishlistAndProduct.mockResolvedValue(
        buildItem({
          product: {
            ...buildProduct(),
            images: [],
            variants: [
              buildVariant({
                inventory: { quantity: 4, reservedQuantity: 4 },
              }),
            ],
          },
        }),
      );

      const result = await service.addItem(
        USER_ID,
        buildAddDto({ productId: PRODUCT_ID }),
      );

      expect(result.product.variants[0].available).toBe(0);
      expect(result.product.inStock).toBe(false);
    });

    it('compares prices as decimals, not as strings', async () => {
      wishlistFindItemByWishlistAndProduct.mockResolvedValue(
        buildItem({
          product: {
            ...buildProduct(),
            images: [],
            variants: [
              buildVariant({ id: 'v-1', sku: 'A', price: '9.90' }),
              buildVariant({
                id: 'v-2',
                sku: 'B',
                price: '10.00',
                inventory: { quantity: 1, reservedQuantity: 0 },
              }),
              buildVariant({ id: 'v-3', sku: 'C', price: '9.99' }),
            ],
          },
        }),
      );

      const result = await service.addItem(
        USER_ID,
        buildAddDto({ productId: PRODUCT_ID }),
      );

      expect(result.product.priceRange).toEqual({
        min: '9.90',
        max: '10.00',
      });
    });

    it('keeps a single-variant range as the same amount twice', async () => {
      wishlistFindItemByWishlistAndProduct.mockResolvedValue(buildItem());

      const result = await service.addItem(
        USER_ID,
        buildAddDto({ productId: PRODUCT_ID }),
      );

      expect(result.product.priceRange).toEqual({
        min: '19.99',
        max: '19.99',
      });
    });
  });
});
