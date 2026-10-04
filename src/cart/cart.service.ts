import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { availableStock } from '../common/utils/available-stock.js';
import { Prisma } from '../generated/prisma/client.js';
import { InventoryRepository } from '../inventory/repositories/inventory.repository.js';
import { ProductVariantsRepository } from '../product-variants/repositories/product-variants.repository.js';
import { UsersRepository } from '../users/repositories/users.repository.js';
import { AddCartItemDto } from './dto/add-cart-item.dto.js';
import { CartItemResponseDto } from './dto/cart-item-response.dto.js';
import { CartResponseDto } from './dto/cart-response.dto.js';
import { UpdateCartItemDto } from './dto/update-cart-item.dto.js';
import {
  CartRepository,
  type CartItemCatalog,
  type CartTransactionClient,
  type CartWithItems,
} from './repositories/cart.repository.js';

const PRISMA_UNIQUE_CONSTRAINT_VIOLATION = 'P2002';
const PRISMA_FOREIGN_KEY_CONSTRAINT_VIOLATION = 'P2003';
const CART_ITEM_MODEL = 'CartItem';
const CART_MODEL = 'Cart';
const CART_ID_FIELD = 'cartId';
const CART_ID_COLUMN = 'cart_id';
const VARIANT_ID_FIELD = 'variantId';
const VARIANT_ID_COLUMN = 'variant_id';
const USER_ID_FIELD = 'userId';
const USER_ID_COLUMN = 'user_id';
const POSTGRES_FOREIGN_KEY_VIOLATION = '23503';
const CART_ITEMS_VARIANT_FK = 'cart_items_variant_id_fkey';

/** How many times an add retries after losing the unique-index race. */
const ADD_ATTEMPTS = 2;

const VARIANT_INACTIVE_MESSAGE =
  'Product variant is not active and cannot be added to a cart';
const INSUFFICIENT_STOCK_MESSAGE =
  'Requested quantity exceeds the available stock for this product variant';
const CART_CHANGED_MESSAGE = 'Cart changed concurrently; retry the request';
const VARIANT_RESTRICTED_MESSAGE =
  'Product variant is referenced by a cart and cannot be deleted';

/**
 * All cart business rules live here; the repository only knows about SQL and the
 * controller only knows about HTTP.
 *
 * ## A cart is intent, not a reservation
 *
 * Nothing in this service writes `inventory.reserved_quantity`. Adding a line
 * records what a user *wants*; it claims nothing. Stock may therefore shrink
 * after a line exists, and `GET /cart` reports that honestly by returning the
 * current `available` next to every line plus an `exceedsAvailable` flag.
 * Rejecting or trimming an unfulfillable line at read time would hide the
 * problem from the user instead of showing it to them, and silently rewriting
 * their cart would be worse than both. The authoritative re-validation and the
 * reservation happen at checkout, which is the only place allowed to move
 * `reservedQuantity`.
 *
 * ## Ownership
 *
 * Every line is addressed through the resolved cart, never through a bare line
 * id. "No such line" and "that line is in another user's cart" are the same 404,
 * so one user's cart cannot be probed through another's identifiers.
 *
 * ## The duplicate-variant rule
 *
 * A variant appears at most once per cart, which the unique index on
 * `(cart_id, variant_id)` guarantees. Adding a variant that is already in the
 * cart *increments* its line instead of inserting a second row, and the
 * resulting total — not the requested increment — is what gets compared against
 * available stock.
 *
 * ## Error semantics
 *
 * | Condition                                          | Status | Rationale                                        |
 * | -------------------------------------------------- | ------ | ------------------------------------------------ |
 * | Missing / malformed `X-User-Id`                    | 400    | Rejected by `ParseUUIDPipe`, before the service.  |
 * | User does not exist                                | 404    | The claimed identity is not a real user.          |
 * | Malformed `variantId` in the body                  | 400    | Rejected by the DTO validator.                    |
 * | Zero, negative or fractional quantity              | 400    | Rejected by the DTO validator.                    |
 * | Malformed `:itemId`                                | 400    | Rejected by `ParseUUIDPipe`, before the service.  |
 * | Variant does not exist                             | 404    | The addressed resource is absent.                 |
 * | Variant exists but is inactive                     | 400    | Valid id, but the request cannot be fulfilled.    |
 * | Variant has no inventory row                       | 404    | Sellability cannot be established.                |
 * | Requested total exceeds available stock            | 409    | Well-formed request conflicting with current stock.|
 * | Line is absent, or belongs to another cart         | 404    | Same 404, so ownership cannot be probed.          |
 * | Concurrent add lost the unique-index race          | (retried) | Retried as an increment; never surfaced.        |
 *
 * A foreign key failure on write (`P2003`) is *not* mapped: by the time a line is
 * written its cart and variant have already been validated, so a violation means
 * one of them was removed concurrently — a genuine fault that must surface as a
 * 500 rather than invite the client to retry blindly. The one exception is the
 * `ON DELETE RESTRICT` on `cart_items.variant_id`, which is reported as the
 * conflict it is (see {@link rethrowAsHttpError}).
 */
@Injectable()
export class CartService {
  constructor(
    private readonly cartRepository: CartRepository,
    private readonly inventoryRepository: InventoryRepository,
    private readonly productVariantsRepository: ProductVariantsRepository,
    private readonly usersRepository: UsersRepository,
  ) {}

  /**
   * Returns the user's cart, creating an empty one on first read.
   *
   * Creating on read is deliberate: a storefront loads the cart on every page,
   * and making that fail with a 404 until the user happens to add something would
   * push "if the cart does not exist, make one" logic into every client.
   */
  async findCart(userId: string): Promise<CartResponseDto> {
    await this.requireUser(userId);

    return CartResponseDto.fromEntity(await this.resolveCart(userId));
  }

  /**
   * Adds `quantity` of a variant to the user's cart.
   *
   * The variant must exist, be active and be stocked, and the *total* the line
   * would reach must fit in the stock currently available. When the variant is
   * already in the cart its line is incremented rather than duplicated.
   *
   * The whole read-then-write runs inside one transaction, and the increment is a
   * single guarded statement (`quantity <= available - n`), so two concurrent
   * adds of the same variant cannot both move the line past the available stock.
   * The insert path is additionally retried once: two concurrent adds that both
   * find no line will both try to insert, the unique index rejects the loser, and
   * the retry turns that rejection into the increment it should have been.
   */
  async addItem(
    userId: string,
    dto: AddCartItemDto,
  ): Promise<CartItemResponseDto> {
    await this.requireUser(userId);

    const variant = await this.requireSellableVariant(dto.variantId);
    const inventory = await this.requireInventory(dto.variantId);
    const cart = await this.resolveCart(userId);

    for (let attempt = 1; attempt <= ADD_ATTEMPTS; attempt += 1) {
      try {
        return await this.cartRepository.runInTransaction(async (tx) => {
          const existing = await this.cartRepository.findItemByCartAndVariant(
            cart.id,
            variant.id,
            tx,
          );

          if (existing !== null) {
            return CartItemResponseDto.fromCatalog(
              await this.incrementLine(
                cart.id,
                existing,
                dto.quantity,
                inventory,
                tx,
              ),
            );
          }

          if (dto.quantity > availableStock(inventory)) {
            throw new ConflictException(INSUFFICIENT_STOCK_MESSAGE);
          }

          const created = await this.cartRepository.createItem(
            { cartId: cart.id, variantId: variant.id, quantity: dto.quantity },
            tx,
          );

          return CartItemResponseDto.fromCatalog(created);
        });
      } catch (error) {
        if (attempt < ADD_ATTEMPTS && this.isCartItemUniqueViolation(error)) {
          continue;
        }

        throw this.rethrowAsHttpError(error);
      }
    }

    /* c8 ignore next */
    throw new ConflictException(INSUFFICIENT_STOCK_MESSAGE);
  }

  /**
   * Sets an existing line to an absolute quantity.
   *
   * The stock read and the write happen in one transaction so the line is never
   * written against a half-read view of its own variant's stock. Only the target
   * quantity is checked, because that is what the line will be: a `PATCH` replaces
   * the value rather than adding to it.
   *
   * The variant's `isActive` flag is deliberately *not* re-checked here. Lowering
   * or removing a line must always remain possible — that is the customer's way
   * out of a basket that has become unsellable — and the same reasoning is why
   * `DELETE` never looks at stock either.
   */
  async updateItem(
    userId: string,
    itemId: string,
    dto: UpdateCartItemDto,
  ): Promise<CartItemResponseDto> {
    await this.requireUser(userId);

    const cart = await this.requireCart(userId);

    return this.cartRepository.runInTransaction(async (tx) => {
      const item = await this.cartRepository.findItemByIdAndCart(
        itemId,
        cart.id,
        tx,
      );

      if (item === null) {
        throw this.cartItemNotFound(itemId);
      }

      const inventory = await this.requireInventory(item.variantId, tx);

      if (dto.quantity > availableStock(inventory)) {
        throw new ConflictException(INSUFFICIENT_STOCK_MESSAGE);
      }

      const updated = await this.cartRepository.updateItemQuantity(
        item.id,
        dto.quantity,
        tx,
      );

      return CartItemResponseDto.fromCatalog(updated);
    });
  }

  /**
   * Removes one line from the user's cart.
   *
   * Ownership and removal are one statement in the repository, so a line that
   * moved out from under the check simply deletes nothing and answers 404.
   */
  async removeItem(userId: string, itemId: string): Promise<void> {
    await this.requireUser(userId);

    const cart = await this.requireCart(userId);
    const removed = await this.cartRepository.deleteItemByIdAndCart(
      itemId,
      cart.id,
    );

    if (removed === 0) {
      throw this.cartItemNotFound(itemId);
    }
  }

  /**
   * Empties the user's cart, keeping the cart itself.
   *
   * Idempotent: a user with no cart, or an already-empty one, is a success rather
   * than a 404, because "make sure my cart is empty" is the intent and it already
   * holds. Deleting the cart row instead would hand the client a new cart id on
   * every clear and break any state it kept against that id.
   */
  async clearCart(userId: string): Promise<void> {
    await this.requireUser(userId);

    const cart = await this.cartRepository.findByUserId(userId);

    if (cart === null) {
      return;
    }

    await this.cartRepository.deleteItemsByCart(cart.id);
  }

  /**
   * Returns the user's cart, creating it on first touch.
   *
   * The unique index on `user_id` settles a concurrent first-request race: two
   * simultaneous calls both find no cart, both insert, and the loser's insert is
   * rejected. The loser re-reads and gets the cart the winner created, so the
   * caller never sees the conflict.
   */
  private async resolveCart(userId: string): Promise<CartWithItems> {
    const existing = await this.cartRepository.findByUserId(userId);

    if (existing !== null) {
      return existing;
    }

    try {
      return await this.cartRepository.createForUser(userId);
    } catch (error) {
      if (this.isCartUniqueViolation(error)) {
        const cart = await this.cartRepository.findByUserId(userId);

        if (cart !== null) {
          return cart;
        }
      }

      throw error;
    }
  }

  /**
   * Returns the user's existing cart or 404 — used by the writes that address an
   * existing line, so a read-modify-write never brings a cart into existence as a
   * side effect.
   */
  private async requireCart(userId: string): Promise<CartWithItems> {
    const cart = await this.cartRepository.findByUserId(userId);

    if (cart === null) {
      throw new NotFoundException(`Cart for user ${userId} does not exist`);
    }

    return cart;
  }

  /**
   * Confirms the claimed identity is a real user.
   *
   * The temporary identity header is an unverified claim, so this check is what
   * stops a caller from creating a cart against a user id that does not exist (or
   * no longer does) — which would otherwise surface as an opaque foreign key
   * failure.
   */
  private async requireUser(userId: string): Promise<void> {
    const user = await this.usersRepository.findById(userId);

    if (user === null) {
      throw new NotFoundException(`User ${userId} does not exist`);
    }
  }

  /**
   * Loads a variant that may be put in a cart: it must exist and be active.
   *
   * "Missing" and "inactive" get different statuses because they are different
   * facts and the client can act on them differently — a 404 means fix the
   * identifier, a 400 means this thing is not for sale right now.
   */
  private async requireSellableVariant(variantId: string) {
    const variant = await this.productVariantsRepository.findById(variantId);

    if (variant === null) {
      throw new NotFoundException(
        `Product variant ${variantId} does not exist`,
      );
    }

    if (!variant.isActive) {
      throw new BadRequestException(VARIANT_INACTIVE_MESSAGE);
    }

    return variant;
  }

  /**
   * Loads the stock row a cart write needs to make a decision.
   *
   * Stock is optional per variant, so "no inventory row" is reported as 404
   * rather than silently treated as zero: the difference between "sold out" and
   * "not stocked" is one a caller can act on.
   */
  private async requireInventory(
    variantId: string,
    tx?: CartTransactionClient,
  ) {
    const inventory = await this.inventoryRepository.findByVariantId(
      variantId,
      tx,
    );

    if (inventory === null) {
      throw new NotFoundException(
        `Inventory for product variant ${variantId} does not exist`,
      );
    }

    return inventory;
  }

  /**
   * Raises an existing line by `quantity`, with the stock ceiling enforced by the
   * database rather than by a check made before the write.
   *
   * The pre-check gives the good error message in the common case. It cannot be
   * the guarantee: another request may consume the same headroom between the read
   * and the write, which is exactly what the guarded statement is for. When the
   * guard rejects the write the line is re-read to tell "the line is gone" apart
   * from "not enough stock".
   */
  private async incrementLine(
    cartId: string,
    existing: CartItemCatalog,
    quantity: number,
    inventory: { quantity: number; reservedQuantity: number },
    tx: CartTransactionClient,
  ): Promise<CartItemCatalog> {
    const available = availableStock(inventory);

    if (existing.quantity + quantity > available) {
      throw new ConflictException(INSUFFICIENT_STOCK_MESSAGE);
    }

    const incremented =
      await this.cartRepository.incrementItemQuantityWithinAvailable(
        existing.id,
        quantity,
        available,
        tx,
      );

    if (incremented === 0) {
      const current = await this.cartRepository.findItemByIdAndCart(
        existing.id,
        cartId,
        tx,
      );

      if (current === null) {
        throw this.cartItemNotFound(existing.id);
      }

      throw new ConflictException(INSUFFICIENT_STOCK_MESSAGE);
    }

    const updated = await this.cartRepository.findItemByIdAndCart(
      existing.id,
      cartId,
      tx,
    );

    /* c8 ignore next */
    if (updated === null) {
      throw this.cartItemNotFound(existing.id);
    }

    return updated;
  }

  /** One message for "no such line" and "not your line", so neither is probeable. */
  private cartItemNotFound(itemId: string): NotFoundException {
    return new NotFoundException(`Cart item ${itemId} does not exist`);
  }

  /**
   * Translates the database errors this feature can legitimately produce into
   * HTTP semantics, and rethrows everything else unchanged.
   *
   * A unique violation on `cart_items` is never surfaced: it means a concurrent
   * add won the race and the caller is expected to retry as an increment, so
   * {@link addItem} handles it. A unique violation on `carts` is likewise handled
   * inside {@link resolveCart}. A foreign key violation (`P2003`) whose Postgres
   * cause is the `ON DELETE RESTRICT` on `cart_items.variant_id` *is* surfaced,
   * as a 409: the line is legitimate but the variant was deleted underneath it,
   * and the database is refusing to let that happen silently. Every other known
   * request error is a genuine fault and surfaces as a 500 rather than being
   * laundered into a 4xx.
   */
  private rethrowAsHttpError(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (
        error.code === PRISMA_UNIQUE_CONSTRAINT_VIOLATION &&
        (this.isCartItemUniqueViolation(error) ||
          this.isCartUniqueViolation(error))
      ) {
        throw new ConflictException(CART_CHANGED_MESSAGE);
      }

      if (this.isVariantRestrictViolation(error)) {
        throw new ConflictException(VARIANT_RESTRICTED_MESSAGE);
      }
    }

    throw error;
  }

  /**
   * Detects a unique constraint violation on `cart_items`.
   *
   * Prisma only populates `meta.target` for engines that report it. With driver
   * adapters such as `@prisma/adapter-pg` the meta object carries a
   * `driverAdapterError` instead, so the target is matched first and the model
   * name is the fallback. `id` is a server-generated UUID, so the only unique
   * constraint a `CartItem` insert can violate is `(cart_id, variant_id)` — which
   * is precisely the duplicate-add race this method exists to recognise.
   */
  private isCartItemUniqueViolation(error: unknown): boolean {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== PRISMA_UNIQUE_CONSTRAINT_VIOLATION
    ) {
      return false;
    }

    const target = error.meta?.['target'];

    if (Array.isArray(target)) {
      return (
        target.includes(CART_ID_FIELD) || target.includes(VARIANT_ID_FIELD)
      );
    }

    if (typeof target === 'string') {
      return (
        target.includes(CART_ID_FIELD) ||
        target.includes(CART_ID_COLUMN) ||
        target.includes(VARIANT_ID_FIELD) ||
        target.includes(VARIANT_ID_COLUMN)
      );
    }

    return error.meta?.['modelName'] === CART_ITEM_MODEL;
  }

  /**
   * Detects a unique constraint violation on `carts`.
   *
   * `user_id` is the only unique constraint on `carts` that a create can violate,
   * so the model-name fallback is sufficient for the adapter path.
   */
  private isCartUniqueViolation(error: unknown): boolean {
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

    return error.meta?.['modelName'] === CART_MODEL;
  }

  /**
   * Detects the `ON DELETE RESTRICT` on `cart_items.variant_id` being violated by
   * a variant or product deletion.
   *
   * The driver adapter reports the underlying SQLSTATE in
   * `meta.driverAdapterError.cause.originalCode`; `23503` is
   * `foreign_key_violation`. The constraint name is matched as well, because a
   * plain `23503` on `cart_items` can only be that one constraint — but matching
   * the name keeps the detection honest if the schema ever grows a second one.
   */
  private isVariantRestrictViolation(error: unknown): boolean {
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

    if (meta?.['modelName'] !== CART_ITEM_MODEL) {
      return false;
    }

    const cause = meta?.driverAdapterError?.cause;

    return (
      cause?.originalCode === POSTGRES_FOREIGN_KEY_VIOLATION &&
      cause?.constraint?.index === CART_ITEMS_VARIANT_FK
    );
  }
}
