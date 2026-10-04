import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { ProductsRepository } from '../products/repositories/products.repository.js';
import { UsersRepository } from '../users/repositories/users.repository.js';
import { AddWishlistItemDto } from './dto/add-wishlist-item.dto.js';
import { WishlistItemResponseDto } from './dto/wishlist-item-response.dto.js';
import { WishlistResponseDto } from './dto/wishlist-response.dto.js';
import {
  WishlistRepository,
  type WishlistWithItems,
} from './repositories/wishlist.repository.js';

const PRISMA_UNIQUE_CONSTRAINT_VIOLATION = 'P2002';
const PRISMA_FOREIGN_KEY_CONSTRAINT_VIOLATION = 'P2003';
const WISHLIST_ITEM_MODEL = 'WishlistItem';
const WISHLIST_MODEL = 'Wishlist';
const WISHLIST_ID_FIELD = 'wishlistId';
const WISHLIST_ID_COLUMN = 'wishlist_id';
const PRODUCT_ID_FIELD = 'productId';
const PRODUCT_ID_COLUMN = 'product_id';
const USER_ID_FIELD = 'userId';
const USER_ID_COLUMN = 'user_id';
const POSTGRES_FOREIGN_KEY_VIOLATION = '23503';
const WISHLIST_ITEMS_PRODUCT_FK = 'wishlist_items_product_id_fkey';

/** How many times a save retries after losing the unique-index race. */
const ADD_ATTEMPTS = 2;

const WISHLIST_CHANGED_MESSAGE =
  'Wishlist changed concurrently; retry the request';
const PRODUCT_RESTRICTED_MESSAGE =
  'Product is saved on a wishlist and cannot be deleted';

/**
 * All wishlist business rules live here; the repository only knows about SQL and
 * the controller only knows about HTTP.
 *
 * ## A wishlist is interest, not intent to buy
 *
 * Nothing in this service touches `inventory`. A saved product claims nothing, so
 * it may sell out, be repriced or be deactivated while it sits on the list. Reads
 * therefore join the *current* product rather than a snapshot and report
 * availability as it is at response time. The cart is where stock becomes a
 * promise; a wishlist is only a note to self.
 *
 * That is also why a product's `isActive` flag is *not* checked when saving, unlike
 * the cart's check on the variant. A customer who saved something before it was
 * deactivated must still be able to see it saved, to see that it is unavailable, and
 * to remove it — refusing the save would leave them unable to tidy up their own
 * list. Deactivation is a catalogue fact the *read* reports, not a write restriction.
 *
 * ## Ownership
 *
 * Every item is addressed through the resolved wishlist, never through a bare item
 * id. "No such item" and "that item is in another user's wishlist" are the same
 * 404, so one user's list cannot be probed through another's identifiers.
 *
 * ## The duplicate-product rule
 *
 * A product appears at most once per wishlist, which the unique index on
 * `(wishlist_id, product_id)` guarantees. Saving a product that is already saved is
 * a **no-op that returns the existing entry**, not a 409 and not a second row.
 *
 * Two things make that the right answer rather than a tolerated one:
 *
 * - There is nothing to merge. A cart line holds a quantity, so a duplicate add can
 *   increment it; a wishlist entry holds no quantity, so a duplicate save has
 *   literally nothing to change. Rejecting it would force every client to
 *   distinguish "saved" from "already saved" for no benefit.
 * - A double-click, a retried request and two tabs are ordinary client behaviour.
 *   They must not produce an error the user has to understand, let alone a 500.
 *
 * The unique index makes that safe under concurrency: of two simultaneous saves,
 * one inserts and the other's insert is rejected by the index. The loser re-reads and
 * returns the row the winner wrote, so both requests answer `201` with the *same*
 * item id and exactly one row exists.
 *
 * ## Error semantics
 *
 * | Condition                                       | Status | Rationale                                    |
 * * ----------------------------------------------- | ------ | -------------------------------------------- |
 * | Missing / malformed `X-User-Id`                 | 400    | Rejected by `ParseUUIDPipe`, before the service. |
 * | User does not exist                             | 404    | The claimed identity is not a real user.      |
 * | Malformed `productId` in the body               | 400    | Rejected by the DTO validator.                |
 * | Any unknown field in the body                   | 400    | Rejected by `forbidNonWhitelisted`.          |
 * | Malformed `:itemId`                             | 400    | Rejected by `ParseUUIDPipe`, before the service. |
 * | Product does not exist                          | 404    | The addressed resource is absent.             |
 * | No wishlist yet, on a write that needs one      | 404    | Nothing to address. See {@link clearWishlist}. |
 * | Item absent, or belonging to another wishlist   | 404    | Same 404, so ownership cannot be probed.      |
 * | Product already saved                           | 201    | Idempotent no-op returning the existing entry. |
 * | Concurrent save lost the unique-index race      | (retried) | Retried as a lookup; never surfaced.        |
 *
 * A foreign key failure on write (`P2003`) is not mapped except for the
 * `ON DELETE RESTRICT` on `wishlist_items.product_id`: by the time an entry is
 * written its wishlist and product have already been validated, so any other
 * violation means one of them was removed concurrently — a genuine fault that must
 * surface as a 500 rather than invite the client to retry blindly. The restriction
 * itself is surfaced as a 409 (see {@link rethrowAsHttpError}), because it means a
 * saved product was deleted underneath the list and the caller should be told.
 */
@Injectable()
export class WishlistService {
  constructor(
    private readonly wishlistRepository: WishlistRepository,
    private readonly productsRepository: ProductsRepository,
    private readonly usersRepository: UsersRepository,
  ) {}

  /**
   * Returns the user's wishlist, creating an empty one on first read.
   *
   * Creating on read is deliberate, for the same reason the cart does it: a
   * storefront renders the wishlist badge on every page, and making that fail with a
   * 404 until the user happens to save something would push "if the wishlist does
   * not exist, make one" logic into every client.
   */
  async findWishlist(userId: string): Promise<WishlistResponseDto> {
    await this.requireUser(userId);

    return WishlistResponseDto.fromEntity(await this.resolveWishlist(userId));
  }

  /**
   * Saves `productId` on the user's wishlist.
   *
   * The product must exist. Saving it when it is already saved returns the existing
   * entry with `201` rather than creating a second row or an error.
   *
   * The read-then-write runs inside one transaction, and the insert path is
   * additionally retried once: two concurrent saves of the same product both find no
   * entry, both try to insert, the unique index rejects the loser, and the retry
   * turns that rejection into the lookup it should have been.
   */
  async addItem(
    userId: string,
    dto: AddWishlistItemDto,
  ): Promise<WishlistItemResponseDto> {
    await this.requireUser(userId);

    const product = await this.requireProduct(dto.productId);
    const wishlist = await this.resolveWishlist(userId);

    for (let attempt = 1; attempt <= ADD_ATTEMPTS; attempt += 1) {
      try {
        return await this.wishlistRepository.runInTransaction(async (tx) => {
          const existing =
            await this.wishlistRepository.findItemByWishlistAndProduct(
              wishlist.id,
              product.id,
              tx,
            );

          if (existing !== null) {
            return WishlistItemResponseDto.fromCatalog(existing);
          }

          const created = await this.wishlistRepository.createItem(
            { wishlistId: wishlist.id, productId: product.id },
            tx,
          );

          return WishlistItemResponseDto.fromCatalog(created);
        });
      } catch (error) {
        if (
          attempt < ADD_ATTEMPTS &&
          this.isWishlistItemUniqueViolation(error)
        ) {
          const winner =
            await this.wishlistRepository.findItemByWishlistAndProduct(
              wishlist.id,
              product.id,
            );

          if (winner !== null) {
            return WishlistItemResponseDto.fromCatalog(winner);
          }

          continue;
        }

        throw this.rethrowAsHttpError(error);
      }
    }

    /* c8 ignore next */
    throw new ConflictException(WISHLIST_CHANGED_MESSAGE);
  }

  /**
   * Removes one saved product from the user's wishlist.
   *
   * Ownership and removal are one statement in the repository, so an entry that
   * moved out from under the check simply deletes nothing and answers 404.
   */
  async removeItem(userId: string, itemId: string): Promise<void> {
    await this.requireUser(userId);

    const wishlist = await this.requireWishlist(userId);
    const removed = await this.wishlistRepository.deleteItemByIdAndWishlist(
      itemId,
      wishlist.id,
    );

    if (removed === 0) {
      throw this.wishlistItemNotFound(itemId);
    }
  }

  /**
   * Empties the user's wishlist, keeping the wishlist itself.
   *
   * Idempotent: a user with no wishlist, or an already-empty one, is a success
   * rather than a 404, because "make sure my wishlist is empty" is the intent and it
   * already holds. This is the one write that does *not* create the wishlist as a
   * side effect — deleting something that does not exist is not a reason to create
   * it. Deleting the wishlist row instead would hand the client a new id on every
   * clear and break any state it kept against that id.
   */
  async clearWishlist(userId: string): Promise<void> {
    await this.requireUser(userId);

    const wishlist = await this.wishlistRepository.findByUserId(userId);

    if (wishlist === null) {
      return;
    }

    await this.wishlistRepository.deleteItemsByWishlist(wishlist.id);
  }

  /**
   * Returns the user's wishlist, creating it on first touch.
   *
   * The unique index on `user_id` settles a concurrent first-request race: two
   * simultaneous calls both find no wishlist, both insert, and the loser's insert is
   * rejected. The loser re-reads and gets the wishlist the winner created, so the
   * caller never sees the conflict.
   */
  private async resolveWishlist(userId: string): Promise<WishlistWithItems> {
    const existing = await this.wishlistRepository.findByUserId(userId);

    if (existing !== null) {
      return existing;
    }

    try {
      return await this.wishlistRepository.createForUser(userId);
    } catch (error) {
      if (this.isWishlistUniqueViolation(error)) {
        const wishlist = await this.wishlistRepository.findByUserId(userId);

        if (wishlist !== null) {
          return wishlist;
        }
      }

      throw error;
    }
  }

  /**
   * Returns the user's existing wishlist or 404 — used by the write that addresses
   * an existing item, so a read-modify-write never brings a wishlist into existence
   * as a side effect.
   */
  private async requireWishlist(userId: string): Promise<WishlistWithItems> {
    const wishlist = await this.wishlistRepository.findByUserId(userId);

    if (wishlist === null) {
      throw new NotFoundException(`Wishlist for user ${userId} does not exist`);
    }

    return wishlist;
  }

  /**
   * Confirms the claimed identity is a real user.
   *
   * The temporary identity header is an unverified claim, so this check is what
   * stops a caller from creating a wishlist against a user id that does not exist
   * (or no longer does) — which would otherwise surface as an opaque foreign key
   * failure.
   */
  private async requireUser(userId: string): Promise<void> {
    const user = await this.usersRepository.findById(userId);

    if (user === null) {
      throw new NotFoundException(`User ${userId} does not exist`);
    }
  }

  /**
   * Loads a product that may be saved.
   *
   * Only existence is checked. `isActive` is deliberately not consulted: a wishlist
   * entry is a note to self that must survive the product being deactivated, and the
   * read reports `isActive` and `inStock` so the client can show the truth.
   */
  private async requireProduct(productId: string) {
    const product = await this.productsRepository.findById(productId);

    if (product === null) {
      throw new NotFoundException(`Product ${productId} does not exist`);
    }

    return product;
  }

  /** One message for "no such item" and "not your item", so neither is probeable. */
  private wishlistItemNotFound(itemId: string): NotFoundException {
    return new NotFoundException(`Wishlist item ${itemId} does not exist`);
  }

  /**
   * Translates the database errors this feature can legitimately produce into HTTP
   * semantics, and rethrows everything else unchanged.
   *
   * A unique violation on `wishlist_items` is never surfaced: it means a concurrent
   * save won the race and the caller is expected to retry as a lookup, so
   * {@link addItem} handles it. A unique violation on `wishlists` is likewise handled
   * inside {@link resolveWishlist}. A foreign key violation (`P2003`) whose Postgres
   * cause is the `ON DELETE RESTRICT` on `wishlist_items.product_id` *is* surfaced,
   * as a 409: the entry is legitimate but the product was deleted underneath it, and
   * the database is refusing to let that happen silently. Every other known request
   * error is a genuine fault and surfaces as a 500 rather than being laundered into
   * a 4xx.
   */
  private rethrowAsHttpError(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (
        error.code === PRISMA_UNIQUE_CONSTRAINT_VIOLATION &&
        (this.isWishlistItemUniqueViolation(error) ||
          this.isWishlistUniqueViolation(error))
      ) {
        throw new ConflictException(WISHLIST_CHANGED_MESSAGE);
      }

      if (this.isProductRestrictViolation(error)) {
        throw new ConflictException(PRODUCT_RESTRICTED_MESSAGE);
      }
    }

    throw error;
  }

  /**
   * Detects a unique constraint violation on `wishlist_items`.
   *
   * Prisma only populates `meta.target` for engines that report it. With driver
   * adapters such as `@prisma/adapter-pg` the meta object carries a
   * `driverAdapterError` instead, so the target is matched first and the model name
   * is the fallback. `id` is a server-generated UUID, so the only unique constraint a
   * `WishlistItem` insert can violate is `(wishlist_id, product_id)` — which is
   * precisely the concurrent-save race this method exists to recognise.
   */
  private isWishlistItemUniqueViolation(error: unknown): boolean {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== PRISMA_UNIQUE_CONSTRAINT_VIOLATION
    ) {
      return false;
    }

    const target = error.meta?.['target'];

    if (Array.isArray(target)) {
      return (
        target.includes(WISHLIST_ID_FIELD) || target.includes(PRODUCT_ID_FIELD)
      );
    }

    if (typeof target === 'string') {
      return (
        target.includes(WISHLIST_ID_FIELD) ||
        target.includes(WISHLIST_ID_COLUMN) ||
        target.includes(PRODUCT_ID_FIELD) ||
        target.includes(PRODUCT_ID_COLUMN)
      );
    }

    return error.meta?.['modelName'] === WISHLIST_ITEM_MODEL;
  }

  /**
   * Detects a unique constraint violation on `wishlists`.
   *
   * `user_id` is the only unique constraint on `wishlists` that a create can violate,
   * so the model-name fallback is sufficient for the adapter path.
   */
  private isWishlistUniqueViolation(error: unknown): boolean {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== PRISMA_UNIQUE_CONSTRAINT_VIOLATION
    ) {
      return false;
    }

    const target = error.meta?.['target'];

    if (Array.isArray(target)) {
      return target.includes(USER_ID_FIELD);
    }

    if (typeof target === 'string') {
      return target === USER_ID_FIELD || target === USER_ID_COLUMN;
    }

    return error.meta?.['modelName'] === WISHLIST_MODEL;
  }

  /**
   * Detects the `ON DELETE RESTRICT` on `wishlist_items.product_id` being violated
   * by a product deletion.
   *
   * The driver adapter reports the underlying SQLSTATE in
   * `meta.driverAdapterError.cause.originalCode`; `23503` is `foreign_key_violation`.
   * The constraint name is matched as well, because a plain `23503` on
   * `wishlist_items` can only be that one constraint — but matching the name keeps
   * the detection honest if the schema ever grows a second one.
   */
  private isProductRestrictViolation(error: unknown): boolean {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== PRISMA_FOREIGN_KEY_CONSTRAINT_VIOLATION
    ) {
      return false;
    }

    const meta = error.meta as
      | {
          driverAdapterError?: {
            cause?: {
              originalCode?: string;
              constraint?: { index?: string };
            };
          };
          modelName?: string;
        }
      | undefined;

    if (meta?.['modelName'] !== WISHLIST_ITEM_MODEL) {
      return false;
    }

    const cause = meta?.driverAdapterError?.cause;

    return (
      cause?.originalCode === POSTGRES_FOREIGN_KEY_VIOLATION &&
      cause?.constraint?.index === WISHLIST_ITEMS_PRODUCT_FK
    );
  }
}
