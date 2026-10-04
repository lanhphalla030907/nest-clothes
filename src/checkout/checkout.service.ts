import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { AddressesService } from '../addresses/addresses.service.js';
import type { CartWithItems } from '../cart/repositories/cart.repository.js';
import { CartRepository } from '../cart/repositories/cart.repository.js';
import { InventoryRepository } from '../inventory/repositories/inventory.repository.js';
import type {
  PlaceOrderInput,
  PlaceOrderLine,
  PlaceOrderShipping,
} from '../orders/order.service.js';
import {
  OrderService,
  type ResolvedOrderLine,
} from '../orders/order.service.js';
import type { OrderWithItems } from '../orders/repositories/order.repository.js';
import { UsersRepository } from '../users/repositories/users.repository.js';
import { CheckoutResponseDto } from './dto/checkout-response.dto.js';
import type { CheckoutDto } from './dto/checkout.dto.js';

/**
 * A Prisma client bound to an interactive transaction.
 *
 * Every repository checkout touches declares its own alias for this same type. They
 * are all `Prisma.TransactionClient`, which is what allows a single transaction
 * client to be handed to all four of them — one connection, one transaction, one
 * commit.
 */
export type CheckoutTransactionClient = Prisma.TransactionClient;

/**
 * How many times the whole checkout is retried after losing a race it cannot win.
 *
 * Two retryable conditions exist, and both are retried by re-running the entire
 * transaction from the outside — never by re-issuing a statement inside it:
 *
 * 1. the generated order number lost the `UNIQUE` race (the `P2002` that
 *    {@link OrderService.isOrderNumberCollision} recognises), and
 * 2. PostgreSQL aborted the transaction with a serialization failure (`40001`) or a
 *    deadlock (`40P01`) — the two errors that mean "your transaction was fine, try
 *    again", as opposed to a constraint violation, which means it was not fine.
 *
 * Three attempts against a ~2.18-billion-per-day number space is not a bound anyone
 * should rely on; it is here so the method terminates instead of retrying forever.
 */
const CHECKOUT_ATTEMPTS = 3;

const PRISMA_TRANSACTION_CONFLICT = 'P2034';
const PG_SERIALIZATION_FAILURE = '40001';
const PG_DEADLOCK_DETECTED = '40P01';

const EMPTY_CART_MESSAGE = 'Cannot check out an empty cart';
const CART_MISSING_MESSAGE = 'Cart does not exist';
const NON_POSITIVE_QUANTITY_MESSAGE =
  'Cart line quantity must be a positive whole number';
const NOT_STOCKED_MESSAGE =
  'Product variant is not stocked and cannot be ordered';
const INSUFFICIENT_STOCK_MESSAGE =
  'Requested quantity exceeds the available stock for this product variant';
const CHECKOUT_RETRIED_MESSAGE =
  'Checkout could not be completed; retry the request';

/**
 * Turns a cart into an order, atomically.
 *
 * ## The one invariant everything else serves
 *
 * A checkout either produces a complete order **and** holds exactly the stock it
 * needs **and** leaves an empty cart, or it changes nothing at all. There is no
 * third outcome. Concretely, never any of these:
 *
 * - an order whose lines were not all written;
 * - stock held for an order that does not exist (the customer's intent silently
 *   removed from the sellable pool forever);
 * - an order for stock nobody held, so two customers can be told the same unit is
 *   theirs;
 * - a cart emptied of items that were never bought;
 * - a cart left full because the order went through.
 *
 * That is achieved with one database transaction and nothing else clever. Every
 * step below runs against the same client: validate, resolve and price, reserve
 * stock, write the order, empty the cart. Any failure throws, and a throw inside
 * {@link OrderRepository}'s transaction rolls the whole thing back — including the
 * reservations, which is why no compensating "release" path exists or is needed.
 *
 * ## Why stock is reserved *inside* the transaction, after pricing
 *
 * The order of the steps is deliberate.
 *
 * *Validate and price first*, so a business rule that cannot be satisfied (an
 * inactive variant, a withdrawn product, a variant with no price) fails before any
 * row lock is taken. Failing early means fewer locks held for shorter, which is the
 * cheapest way to be a good citizen of the connection pool.
 *
 * *Reserve after pricing, before writing.* Reserving first would hold stock for a
 * line that might turn out to be unbuyable. Writing first would record an order for
 * stock that was never secured — the one failure mode that is actually dangerous.
 * In between, both halves of the promise are still true or still false together.
 *
 * *Empty the cart last*, because clearing it is the only step whose loss is visible
 * to the customer. If any earlier step fails, the cart is exactly as it was and the
 * customer can simply try again.
 *
 * ## How stock is reserved
 *
 * Not by reading `available` and writing it back — that races, and with stock 5 and
 * concurrent requests for 4 and 3 it oversells. The reservation is a single guarded
 * statement, {@link InventoryRepository.reserve}, which PostgreSQL evaluates against
 * the row it locks: `SET reserved_quantity = reserved_quantity + n WHERE
 * quantity - reserved_quantity >= n`. The loser of any race is told so by the
 * statement affecting zero rows, which is what produces the 409. `quantity` is never
 * written: reserving is not restocking.
 *
 * Reservations are taken in a fixed order — variant id ascending — for every
 * checkout. Two customers checking out overlapping baskets in opposite line order
 * would otherwise be able to grab each other's rows in opposite orders and deadlock;
 * a consistent global order makes that impossible. The order the lines are *written*
 * in is untouched, because it is part of the receipt.
 *
 * ## What this phase deliberately does not do
 *
 * No payment, no tax, no shipping rate, no coupons, no order cancellation and no
 * refunds. `shippingFee` and `discountAmount` are therefore zero on every order
 * placed here, and `currency` is the order default. The reservation is a *hold*,
 * not a deduction: `quantity` is untouched and the stock becomes sellable again
 * only when something explicitly releases the hold in a later phase.
 */
@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);

  constructor(
    private readonly cartRepository: CartRepository,
    private readonly inventoryRepository: InventoryRepository,
    private readonly orderService: OrderService,
    private readonly addressesService: AddressesService,
    private readonly usersRepository: UsersRepository,
  ) {}

  /**
   * Converts the caller's cart into an order and reserves the stock for it.
   *
   * @param userId The claimed identity from `X-User-Id`; verified to be a real user.
   * @param dto The address to ship to; verified to belong to that user.
   * @returns The order just written, read back inside the same transaction.
   * @throws BadRequest 400 when the cart is empty, a quantity is not a positive
   *   whole number, or a variant or product is not sellable.
   * @throws NotFound 404 when the user or the address does not exist, or when the
   *   address belongs to somebody else — the same 404 for both, so neither is
   *   probeable.
   * @throws Conflict 409 when a variant is not stocked at all, or when the guarded
   *   reservation statement refused the hold because another checkout got there
   *   first.
   */
  async checkout(
    userId: string,
    dto: CheckoutDto,
  ): Promise<CheckoutResponseDto> {
    await this.requireUser(userId);

    // The retry loop is outside the transaction, deliberately. In PostgreSQL a
    // failed statement leaves the transaction aborted — every later statement in it
    // fails with "current transaction is aborted" — so the only way to retry is to
    // roll back and start again. Each attempt below is a whole, independent
    // transaction, and a failed attempt leaves no order, no stock hold and no
    // emptied cart behind it.
    for (let attempt = 1; attempt <= CHECKOUT_ATTEMPTS; attempt += 1) {
      const orderNumber = await this.orderService.drawOrderNumber();

      try {
        const order = await this.orderRepositoryTransaction((tx) =>
          this.checkoutInTransaction(userId, dto, orderNumber, tx),
        );

        return CheckoutResponseDto.fromOrder(order);
      } catch (error) {
        if (attempt < CHECKOUT_ATTEMPTS && this.isRetryable(error)) {
          this.logger.warn(
            `Checkout lost a race and will be retried whole (attempt ${attempt} of ${CHECKOUT_ATTEMPTS})`,
          );
          continue;
        }

        this.throwMapped(error);
      }
    }

    /* c8 ignore next 3 -- every iteration above returns or throws */
    throw new BadRequestException(CHECKOUT_RETRIED_MESSAGE);
  }

  /**
   * The whole checkout, in one transaction.
   *
   * Runs in the exact order documented on the class: read the cart, copy the
   * address, price the lines, reserve the stock, write the order, empty the cart.
   * Called once per attempt by {@link checkout}, and it holds no retry logic of its
   * own, because a retry in here would run against an aborted transaction.
   */
  private async checkoutInTransaction(
    userId: string,
    dto: CheckoutDto,
    orderNumber: string,
    tx: CheckoutTransactionClient,
  ): Promise<OrderWithItems> {
    const cart = await this.requireCartWithItems(userId, tx);
    const address = await this.requireOwnedAddress(userId, dto.addressId, tx);
    const lines = this.cartLines(cart);
    const input = this.buildOrderInput(userId, address, lines);

    // Priced from the catalogue on this transaction's view, and snapshotted onto the
    // lines: from here on the order's figures cannot change, whatever the catalogue
    // does next.
    const resolved = await this.orderService.resolveOrderLines(
      lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity })),
      tx,
    );

    await this.reserveStockForLines(resolved, tx);

    const order = await this.orderService.writeOrder(
      input,
      resolved,
      orderNumber,
      tx,
    );

    // Last, and only now: the order exists on this transaction, so emptying the cart
    // can no longer lose a purchase.
    await this.cartRepository.deleteItemsByCart(cart.id, tx);

    return order;
  }

  /**
   * Holds stock for every line, or holds nothing at all.
   *
   * Two rejections are distinguished, and the difference is worth a read:
   *
   * - **no inventory row** means the variant is not tracked for stock at all. The
   *   guarded update cannot tell that apart from "not enough", because both change
   *   zero rows, and "we do not stock this" is a different thing to tell a customer
   *   than "we are out of it". The read that distinguishes them happens *inside* the
   *   transaction and is not load-bearing for correctness — {@link
   *   InventoryRepository.reserve} is still the only thing that decides whether stock
   *   is actually held.
   * - **not enough stock** is the guarded update refusing, and it is authoritative:
   *   it means another checkout took the remainder between the read and the write.
   *
   * Lines are visited in variant-id order regardless of the order they appear in the
   * cart, so overlapping baskets cannot deadlock against each other.
   */
  private async reserveStockForLines(
    lines: ResolvedOrderLine[],
    tx: CheckoutTransactionClient,
  ): Promise<void> {
    const byVariantId = [...lines].sort((left, right) =>
      left.variantId < right.variantId ? -1 : 1,
    );

    for (const line of byVariantId) {
      if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
        throw new BadRequestException(NON_POSITIVE_QUANTITY_MESSAGE);
      }

      const inventory = await this.inventoryRepository.findByVariantId(
        line.variantId,
        tx,
      );

      if (inventory === null) {
        throw new ConflictException(
          `${NOT_STOCKED_MESSAGE}: ${line.sku}`,
        );
      }

      const reserved = await this.inventoryRepository.reserve(
        line.variantId,
        line.quantity,
        tx,
      );

      if (reserved === 0) {
        throw new ConflictException(
          `${INSUFFICIENT_STOCK_MESSAGE}: ${line.sku}`,
        );
      }
    }
  }

  /**
   * The caller's cart, with its lines.
   *
   * A cart row is created lazily by the cart feature on first read, so "no cart" is a
   * real state a client can reach by never having used one. It is a 404 rather than
   * a 400 because the request named a resource that does not exist — the cart a
   * checkout needs is simply not there yet.
   */
  private async requireCartWithItems(
    userId: string,
    tx: CheckoutTransactionClient,
  ): Promise<CartWithItems> {
    const cart = await this.cartRepository.findByUserId(userId, tx);

    if (cart === null) {
      throw new NotFoundException(CART_MISSING_MESSAGE);
    }

    if (cart.items.length === 0) {
      throw new BadRequestException(EMPTY_CART_MESSAGE);
    }

    return cart;
  }

  /**
   * The cart's lines as order lines.
   *
   * Carries the variant id and the quantity and nothing else. In particular no price:
   * a client cannot state what it pays, because there is nowhere in this type for it
   * to put one. `(cart_id, variant_id)` is unique, so a cart cannot hold the same
   * variant twice and this cannot silently drop a line.
   */
  private cartLines(cart: CartWithItems): PlaceOrderLine[] {
    return cart.items.map((item) => ({
      variantId: item.variantId,
      quantity: item.quantity,
    }));
  }

  /**
   * Assembles the order-to-be from the stored address and the catalogue defaults.
   *
   * The address is **copied** from the address book row, not referenced. That is what
   * makes the order a receipt: editing or deleting the saved address afterwards must
   * not rewrite where a parcel was sent, so every field is read once, here, and
   * frozen onto the order.
   *
   * `shippingFee` and `discountAmount` are left unset, and `currency` with them, so
   * {@link OrderService.writeOrder} applies the order defaults: zero, zero and the
   * default currency. Naming them here would be a claim that this phase calculates a
   * shipping rate or a discount, which it does not.
   */
  private buildOrderInput(
    userId: string,
    address: {
      recipientName: string;
      phone: string;
      addressLine1: string;
      addressLine2: string | null;
      city: string;
      stateProvince: string | null;
      postalCode: string | null;
      countryCode: string;
    },
    lines: PlaceOrderLine[],
  ): PlaceOrderInput {
    const shipping: PlaceOrderShipping = {
      recipientName: address.recipientName,
      phone: address.phone,
      addressLine1: address.addressLine1,
      addressLine2: address.addressLine2,
      city: address.city,
      stateProvince: address.stateProvince,
      postalCode: address.postalCode,
      countryCode: address.countryCode,
    };

    return { userId, lines, shipping };
  }

  /**
   * Confirms the claimed identity is a real user.
   *
   * The `X-User-Id` header is an unverified claim, so this is what stops a checkout
   * creating an order for a user id that does not exist. Done before the transaction
   * opens because it cannot succeed or fail depending on anything inside it.
   */
  private async requireUser(userId: string): Promise<void> {
    const user = await this.usersRepository.findById(userId);

    if (user === null) {
      throw new NotFoundException(`User ${userId} does not exist`);
    }
  }

  /**
   * The shipping address, or 404.
   *
   * Delegates to `AddressesService` so the ownership rule stays in one place: this
   * service never sees another user's address, and cannot accidentally skip the
   * check by reading the row itself. The read runs on the checkout transaction, so
   * "you may ship here" and "we shipped here" are decided on one view.
   */
  private requireOwnedAddress(
    userId: string,
    addressId: string,
    tx: CheckoutTransactionClient,
  ) {
    return this.addressesService.findOne(userId, addressId, tx);
  }

  /**
   * Runs one attempt inside a single interactive transaction.
   *
   * `OrderRepository` owns the helper, and checkout borrows it rather than opening a
   * second transaction of its own: two helpers would be two chances to commit half a
   * checkout, and Nest's provider graph is the only place that decision belongs.
   */
  private orderRepositoryTransaction<T>(
    work: (tx: CheckoutTransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.cartRepository.runInTransaction((tx) => work(tx));
  }

  /**
   * Whether this failure means "run the whole thing again".
   *
   * Exactly two families qualify, and both are the database saying *retry*, not
   * *your request was wrong*:
   *
   * - the order number lost the `UNIQUE` race — {@link
   *   OrderService.isOrderNumberCollision}, which also insists the constraint was
   *   `order_number` so an unrelated uniqueness failure is not mistaken for one;
   * - a serialization failure (`40001`) or deadlock (`40P01`), which PostgreSQL
   *   raises when concurrent transactions could not be ordered.
   *
   * A `CHECK` violation is *not* retryable: it means the arithmetic was wrong, and
   * running it again would produce the same wrong answer more slowly. Neither is a
   * 409 for stock, which is a fact rather than a fault.
   */
  private isRetryable(error: unknown): boolean {
    if (this.orderService.isOrderNumberCollision(error)) {
      return true;
    }

    if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
      return false;
    }

    // These three reach us in different shapes depending on the driver adapter in
    // use, so all of them are recognised rather than the one this build happens to
    // produce: Prisma normalises them to `P2034`, some paths pass the raw SQLSTATE
    // through as the code, and some only surface it inside the message text. Missing
    // one shape would turn a retryable conflict into a 500 for a client.
    return (
      error.code === PRISMA_TRANSACTION_CONFLICT ||
      error.code === PG_SERIALIZATION_FAILURE ||
      error.code === PG_DEADLOCK_DETECTED ||
      error.message.includes(PG_SERIALIZATION_FAILURE) ||
      error.message.includes(PG_DEADLOCK_DETECTED)
    );
  }

  /**
   * Rethrows a failure that is not worth retrying.
   *
   * `HttpException`s — every 400, 404 and 409 this service raises — pass straight
   * through, so the client's answer is the one the check that failed intended. A
   * Nest-internal error (`HttpException` from the framework, not from here) is passed
   * through too. Anything else is a bug rather than a rejected request, so it is
   * reported as a 500 instead of leaking a driver's message.
   */
  private throwMapped(error: unknown): never {
    if (error instanceof HttpException) {
      throw error;
    }

    this.logger.error('Checkout failed unexpectedly', error);

    throw new BadRequestException(CHECKOUT_RETRIED_MESSAGE);
  }
}
