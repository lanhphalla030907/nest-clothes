import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * A Prisma client bound to an interactive transaction.
 *
 * Repository methods accept one so the service can run a read followed by a
 * write against the *same* connection and transaction. That is what makes the
 * "find the line, then increment it" sequence atomic instead of racing another
 * writer between the two statements.
 */
export type CartTransactionClient = Prisma.TransactionClient;

/**
 * The exact columns `CartRepository.createItem` is allowed to write.
 *
 * `id`, `createdAt` and `updatedAt` are absent because they are database-owned
 * and must never be reachable from a request payload.
 *
 * Both foreign keys are present because a line cannot exist without them, and
 * the service fills them in from the resolved cart and the requested variant —
 * never from the body.
 */
export interface CreateCartItemData {
  cartId: string;
  variantId: string;
  quantity: number;
}

/**
 * The catalog projection every cart read shares.
 *
 * A cart line is useless to a storefront on its own: the client needs the SKU and
 * price to label the line, the options to render "Black / M", the product to link
 * to, and the inventory counters to show whether the line is still buyable.
 *
 * This lives here rather than in the service so the query shape is stated once
 * and every read path — `GET /cart` and the response returned by a write —
 * returns the identical structure.
 */
const CART_ITEM_CATALOG_INCLUDE = {
  variant: {
    include: {
      options: { orderBy: [{ optionName: 'asc' }, { id: 'asc' }] },
      product: true,
      inventory: true,
    },
  },
} satisfies Prisma.CartItemInclude;

/**
 * A cart line with everything a storefront needs to render it.
 *
 * Derived from the include above rather than hand-written, so the read shape and
 * the type describing it cannot drift apart. `inventory` stays nullable because
 * the column is optional per variant: `null` means "not stocked", which is a
 * different fact from a stocked-and-sold-out `available` of zero.
 */
export type CartItemCatalog = Prisma.CartItemGetPayload<{
  include: typeof CART_ITEM_CATALOG_INCLUDE;
}>;

/**
 * The cart plus its fully hydrated lines, oldest line first.
 *
 * `items` is ordered by `createdAt` then `id` so two identical requests return
 * the lines in the same order — without the tiebreak, insertion order inside one
 * transaction is not something Postgres guarantees.
 */
export type CartWithItems = Prisma.CartGetPayload<{
  include: typeof CART_WITH_ITEMS_INCLUDE;
}>;

const CART_WITH_ITEMS_INCLUDE = {
  items: {
    include: CART_ITEM_CATALOG_INCLUDE,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
} satisfies Prisma.CartInclude;

/**
 * The only place in the cart feature that talks to the database.
 *
 * It owns `carts` and `cart_items` together because the two are one aggregate: a
 * line has no meaning without its cart and is unreachable without it, so
 * splitting them across repositories would buy an abstraction that cannot be
 * used. `users`, `product_variants`, `products` and `inventory` are *not* owned
 * here — those rows are reached through their own repositories (or through the
 * relation projection below, which only ever reads them).
 *
 * It owns persistence and nothing else: no stock reasoning, no duplicate-line
 * reasoning, no exception mapping, no DTO mapping, no HTTP status decisions.
 *
 * ## Transactions
 *
 * {@link runInTransaction} is the primitive every cart mutation goes through.
 * Adding a line is a read-then-write: find the existing line for a variant, then
 * either increment it or insert it. Running that inside one transaction is what
 * lets the service reason about the line it just read.
 *
 * The database constraints remain the final backstop, not a formality: the
 * unique `(cart_id, variant_id)` index is what makes two concurrent adds of the
 * same variant safe — the loser's insert is rejected rather than producing a
 * second line — and the `quantity > 0` check rejects a write that a concurrent
 * interleaving made invalid.
 */
@Injectable()
export class CartRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Runs `work` in a single interactive transaction and hands it a client bound
   * to that transaction. Use it for every read-modify-write cart mutation.
   */
  runInTransaction<T>(
    work: (tx: CartTransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(work);
  }

  /**
   * Returns the cart belonging to `userId` with its lines fully hydrated, or
   * `null` when the user has never had one.
   *
   * `userId` is unique, so `findUnique` addresses the cart directly and no join
   * is needed to scope it to its owner.
   */
  findByUserId(
    userId: string,
    client: CartTransactionClient = this.prisma,
  ): Promise<CartWithItems | null> {
    return client.cart.findUnique({
      where: { userId },
      include: CART_WITH_ITEMS_INCLUDE,
    });
  }

  /** Persists an empty cart for `userId` and returns it, hydrated. */
  createForUser(
    userId: string,
    client: CartTransactionClient = this.prisma,
  ): Promise<CartWithItems> {
    return client.cart.create({
      data: { userId },
      include: CART_WITH_ITEMS_INCLUDE,
    });
  }

  /**
   * Returns the line `cartId` holds for `variantId`, hydrated, or `null`.
   *
   * `(cart_id, variant_id)` is unique, so at most one row can match and
   * `findUnique` addresses it directly. This is the read half of "add increments
   * the existing line instead of inserting a duplicate".
   */
  findItemByCartAndVariant(
    cartId: string,
    variantId: string,
    client: CartTransactionClient = this.prisma,
  ): Promise<CartItemCatalog | null> {
    return client.cartItem.findUnique({
      where: { cartId_variantId: { cartId, variantId } },
      include: CART_ITEM_CATALOG_INCLUDE,
    });
  }

  /**
   * Returns the line `itemId` only when it belongs to `cartId`, else `null`.
   *
   * Filtering by cart in the query — rather than fetching by id and comparing in
   * the service — means a caller cannot distinguish "no such line" from "that
   * line is in somebody else's cart", which is what lets both answer 404 without
   * leaking another user's cart contents.
   */
  findItemByIdAndCart(
    itemId: string,
    cartId: string,
    client: CartTransactionClient = this.prisma,
  ): Promise<CartItemCatalog | null> {
    return client.cartItem.findUnique({
      where: { id: itemId, cartId },
      include: CART_ITEM_CATALOG_INCLUDE,
    });
  }

  /**
   * Inserts a new line and returns it, hydrated.
   *
   * Rejects with Prisma's `P2002` when the `(cart_id, variant_id)` index is
   * violated, which is exactly the concurrent-add race: the caller retries and
   * the retry finds the line the winner inserted.
   */
  createItem(
    data: CreateCartItemData,
    client: CartTransactionClient = this.prisma,
  ): Promise<CartItemCatalog> {
    return client.cartItem.create({
      data,
      include: CART_ITEM_CATALOG_INCLUDE,
    });
  }

  /**
   * Adds `quantity` to the line `itemId` **only if** the resulting quantity
   * stays at or below `available`, and returns how many rows changed.
   *
   * The guard and the increment are one statement, which is what makes the stock
   * rule hold under concurrency: two writers adding the last unit both pass the
   * service's read of `available`, but only the first can move the stored total
   * to `available` — the second's `WHERE quantity <= available - n` matches
   * nothing and gets `0` back. Doing this as "read available, then write the sum"
   * would let both succeed and oversell.
   *
   * `0` therefore means "rejected", and the service re-reads the line to tell
   * "the line is gone" apart from "not enough stock".
   */
  incrementItemQuantityWithinAvailable(
    itemId: string,
    quantity: number,
    available: number,
    client: CartTransactionClient = this.prisma,
  ): Promise<number> {
    return client.cartItem
      .updateMany({
        where: { id: itemId, quantity: { lte: available - quantity } },
        data: { quantity: { increment: quantity } },
      })
      .then((result) => result.count);
  }

  /**
   * Sets the line `itemId` to an absolute `quantity`, returning it hydrated.
   *
   * The value is absolute rather than a delta so the row stays the whole truth
   * about the line. `cartId` is not part of the address: the service resolves
   * ownership through {@link findItemByIdAndCart} first, so a 404 is decided
   * before this call.
   */
  updateItemQuantity(
    itemId: string,
    quantity: number,
    client: CartTransactionClient = this.prisma,
  ): Promise<CartItemCatalog> {
    return client.cartItem.update({
      where: { id: itemId },
      data: { quantity },
      include: CART_ITEM_CATALOG_INCLUDE,
    });
  }

  /**
   * Deletes the line `itemId` only when it belongs to `cartId`, returning how
   * many rows were removed.
   *
   * `deleteMany` with the owner in the `WHERE` clause is used instead of
   * `delete` so the ownership test and the removal are a single atomic statement:
   * there is no window in which the service's earlier ownership check could have
   * been invalidated by a concurrent write. `0` means the line was not there and
   * the service answers 404.
   */
  deleteItemByIdAndCart(itemId: string, cartId: string): Promise<number> {
    return this.prisma.cartItem
      .deleteMany({ where: { id: itemId, cartId } })
      .then((result) => result.count);
  }

  /**
   * Removes every line of `cartId` and returns how many were removed.
   *
   * Scoped by `deleteMany` rather than by deleting the cart row, so clearing a
   * cart keeps the cart itself — and therefore its id and its `createdAt` — alive.
   * That matters because the client addresses lines by cart-owned id and would
   * otherwise see its cart identifier change every time it emptied the cart.
   */
  deleteItemsByCart(
    cartId: string,
    client: CartTransactionClient = this.prisma,
  ): Promise<number> {
    return client.cartItem
      .deleteMany({ where: { cartId } })
      .then((result) => result.count);
  }
}
