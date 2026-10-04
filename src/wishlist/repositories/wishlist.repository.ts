import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * A Prisma client bound to an interactive transaction.
 *
 * Repository methods accept one so the service can run a read followed by a
 * write against the *same* connection and transaction. That is what makes the
 * "is this product already saved, then save it" sequence atomic instead of racing
 * another writer between the two statements.
 */
export type WishlistTransactionClient = Prisma.TransactionClient;

/**
 * The exact columns `WishlistRepository.createItem` is allowed to write.
 *
 * `id` and `createdAt` are absent because they are database-owned and must never
 * be reachable from a request payload. There is no `updatedAt` to leave out: a
 * saved item has nothing to edit, so the row carries only when it was saved.
 *
 * Both foreign keys are present because a saved product cannot exist without them,
 * and the service fills them in from the resolved wishlist and the requested
 * product — never from the body.
 */
export interface CreateWishlistItemData {
  wishlistId: string;
  productId: string;
}

/**
 * The product projection every wishlist read shares.
 *
 * A saved product is useless to a storefront on its own: the client needs an image
 * to render the card, the active variants to show what can actually be bought and
 * at what price, and the stock counters to say whether any of it is available.
 *
 * Three deliberate choices are hidden in this shape:
 *
 * - **One image, best first.** `is_primary` descending puts the product's chosen
 *   image ahead of the rest, `sort_order` then `created_at` break the tie. `take: 1`
 *   keeps a wishlist listing from dragging every image of every saved product into
 *   memory to use exactly one of them.
 * - **Active variants only.** An inactive variant is not purchasable, so
 *   surfacing it would let a client offer something the checkout will refuse.
 * - **Stock is read, never written.** `inventory` is included for the caller to
 *   *derive* availability; a wishlist is not a claim on stock, so nothing here may
 *   write it. The `available` value the response reports is computed at read time
 *   through the shared `availableStock` helper.
 *
 * This lives here rather than in the service so the query shape is stated once and
 * every read path — `GET /wishlist` and the response returned by a write — returns
 * the identical structure.
 */
const WISHLIST_ITEM_PRODUCT_INCLUDE = {
  product: {
    include: {
      images: {
        orderBy: [
          { isPrimary: 'desc' },
          { sortOrder: 'asc' },
          { createdAt: 'asc' },
        ],
        take: 1,
      },
      variants: {
        where: { isActive: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: {
          options: { orderBy: [{ optionName: 'asc' }, { id: 'asc' }] },
          inventory: true,
        },
      },
    },
  },
} satisfies Prisma.WishlistItemInclude;

/**
 * A saved product with everything a storefront needs to render it.
 *
 * Derived from the include above rather than hand-written, so the read shape and
 * the type describing it cannot drift apart. `images` and `variants` are both
 * arrays because both are genuinely optional: a product may have no image yet and
 * may have no active variant at all, and neither case should make a read fail.
 */
export type WishlistItemProduct = Prisma.WishlistItemGetPayload<{
  include: typeof WISHLIST_ITEM_PRODUCT_INCLUDE;
}>;

/**
 * The wishlist plus its fully hydrated items, oldest item first.
 *
 * `items` is ordered by `createdAt` then `id` so two identical requests return the
 * items in the same order — without the tiebreak, insertion order inside one
 * transaction is not something Postgres guarantees.
 */
export type WishlistWithItems = Prisma.WishlistGetPayload<{
  include: typeof WISHLIST_WITH_ITEMS_INCLUDE;
}>;

const WISHLIST_WITH_ITEMS_INCLUDE = {
  items: {
    include: WISHLIST_ITEM_PRODUCT_INCLUDE,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
} satisfies Prisma.WishlistInclude;

/**
 * The only place in the wishlist feature that talks to the database.
 *
 * It owns `wishlists` and `wishlist_items` together because the two are one
 * aggregate: a saved product has no meaning without its wishlist and is unreachable
 * without it, so splitting them across repositories would buy an abstraction that
 * cannot be used. `users` and `products` are *not* owned here — those rows are
 * reached through their own repositories (or through the relation projection below,
 * which only ever reads them).
 *
 * It owns persistence and nothing else: no duplicate-save reasoning, no exception
 * mapping, no DTO mapping, no HTTP status decisions.
 *
 * ## Transactions
 *
 * {@link runInTransaction} is the primitive every wishlist mutation goes through.
 * Saving a product is a read-then-write: find the entry for that product, then
 * return it or insert it. Running that inside one transaction is what lets the
 * service reason about the row it just read.
 *
 * The database constraints remain the final backstop, not a formality: the unique
 * `(wishlist_id, product_id)` index is what makes two concurrent saves of the same
 * product safe — the loser's insert is rejected rather than producing a second row
 * — and the `ON DELETE RESTRICT` on `product_id` is what refuses to let a catalogue
 * deletion silently alter what a customer saved.
 */
@Injectable()
export class WishlistRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Runs `work` in a single interactive transaction and hands it a client bound to
   * that transaction. Use it for every read-modify-write wishlist mutation.
   */
  runInTransaction<T>(
    work: (tx: WishlistTransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(work);
  }

  /**
   * Returns the wishlist belonging to `userId` with its items fully hydrated, or
   * `null` when the user has never had one.
   *
   * `userId` is unique, so `findUnique` addresses the wishlist directly and no join
   * is needed to scope it to its owner.
   */
  findByUserId(
    userId: string,
    client: WishlistTransactionClient = this.prisma,
  ): Promise<WishlistWithItems | null> {
    return client.wishlist.findUnique({
      where: { userId },
      include: WISHLIST_WITH_ITEMS_INCLUDE,
    });
  }

  /** Persists an empty wishlist for `userId` and returns it, hydrated. */
  createForUser(
    userId: string,
    client: WishlistTransactionClient = this.prisma,
  ): Promise<WishlistWithItems> {
    return client.wishlist.create({
      data: { userId },
      include: WISHLIST_WITH_ITEMS_INCLUDE,
    });
  }

  /**
   * Returns the entry `wishlistId` holds for `productId`, hydrated, or `null`.
   *
   * `(wishlist_id, product_id)` is unique, so at most one row can match and
   * `findUnique` addresses it directly. This is the read half of "saving a product
   * twice is a no-op rather than a second row".
   */
  findItemByWishlistAndProduct(
    wishlistId: string,
    productId: string,
    client: WishlistTransactionClient = this.prisma,
  ): Promise<WishlistItemProduct | null> {
    return client.wishlistItem.findUnique({
      where: { wishlistId_productId: { wishlistId, productId } },
      include: WISHLIST_ITEM_PRODUCT_INCLUDE,
    });
  }

  /**
   * Returns the entry `itemId` only when it belongs to `wishlistId`, else `null`.
   *
   * Filtering by wishlist in the query — rather than fetching by id and comparing
   * in the service — means a caller cannot distinguish "no such entry" from "that
   * entry is in somebody else's wishlist", which is what lets both answer 404
   * without leaking another user's wishlist contents.
   */
  findItemByIdAndWishlist(
    itemId: string,
    wishlistId: string,
    client: WishlistTransactionClient = this.prisma,
  ): Promise<WishlistItemProduct | null> {
    return client.wishlistItem.findUnique({
      where: { id: itemId, wishlistId },
      include: WISHLIST_ITEM_PRODUCT_INCLUDE,
    });
  }

  /**
   * Inserts a new entry and returns it, hydrated.
   *
   * Rejects with Prisma's `P2002` when the `(wishlist_id, product_id)` index is
   * violated, which is exactly the concurrent-save race: the caller retries and the
   * retry finds the entry the winner inserted.
   */
  createItem(
    data: CreateWishlistItemData,
    client: WishlistTransactionClient = this.prisma,
  ): Promise<WishlistItemProduct> {
    return client.wishlistItem.create({
      data,
      include: WISHLIST_ITEM_PRODUCT_INCLUDE,
    });
  }

  /**
   * Deletes the entry `itemId` only when it belongs to `wishlistId`, returning how
   * many rows were removed.
   *
   * `deleteMany` with the owner in the `WHERE` clause is used instead of `delete`
   * so the ownership test and the removal are a single atomic statement: there is
   * no window in which the service's earlier ownership check could have been
   * invalidated by a concurrent write. `0` means the entry was not there and the
   * service answers 404.
   */
  deleteItemByIdAndWishlist(
    itemId: string,
    wishlistId: string,
  ): Promise<number> {
    return this.prisma.wishlistItem
      .deleteMany({ where: { id: itemId, wishlistId } })
      .then((result) => result.count);
  }

  /**
   * Removes every entry of `wishlistId` and returns how many were removed.
   *
   * Scoped by `deleteMany` rather than by deleting the wishlist row, so clearing a
   * wishlist keeps the wishlist itself — and therefore its id and its `createdAt` —
   * alive. That matters because the client holds the wishlist id and would otherwise
   * see it change every time it emptied the list.
   */
  deleteItemsByWishlist(
    wishlistId: string,
    client: WishlistTransactionClient = this.prisma,
  ): Promise<number> {
    return client.wishlistItem
      .deleteMany({ where: { wishlistId } })
      .then((result) => result.count);
  }
}
