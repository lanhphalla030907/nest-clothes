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
import type { AddressResponseDto } from '../addresses/dto/address-response.dto.js';
import { CodAreasRepository } from '../cod-areas/repositories/cod-areas.repository.js';
import { AdministrativeLocationsService } from '../locations/administrative-locations.service.js';
import { AdministrativeLocationResponseDto } from '../locations/dto/administrative-location-response.dto.js';
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
import {
  OrderRepository,
  type OrderWithItems,
} from '../orders/repositories/order.repository.js';
import {
  calculateOrderTotal,
  sumLineTotals,
} from '../orders/utils/order-money.js';
import { ShippingProvidersRepository } from '../shipping-providers/repositories/shipping-providers.repository.js';
import { UsersRepository } from '../users/repositories/users.repository.js';
import { CheckoutQuoteResponseDto } from './dto/checkout-quote-response.dto.js';
import { CheckoutResponseDto } from './dto/checkout-response.dto.js';
import type { CheckoutDto } from './dto/checkout.dto.js';
import type { CreateCheckoutQuoteDto } from './dto/create-checkout-quote.dto.js';
import { CheckoutQuotesRepository } from './repositories/checkout-quotes.repository.js';

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
const QUOTE_EXPIRED_MESSAGE =
  'The checkout quote expired or is no longer valid. Request a new quote';
const QUOTE_REPLAY_MESSAGE =
  'Checkout quote was already consumed by a concurrent request';
const QUOTE_LIFETIME_MS = 10 * 60 * 1000;

class CheckoutIdempotencyRaceError extends Error {
  constructor() {
    super(QUOTE_REPLAY_MESSAGE);
  }
}

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
 * Quote-backed checkout snapshots an active provider's configured base fee and the
 * selected payment method; it does not collect COD, calculate tax or apply
 * discounts. The legacy address-only request remains compatible and still uses the
 * order defaults. Inventory reservation remains a hold, not a deduction.
 */
@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);

  constructor(
    private readonly cartRepository: CartRepository,
    private readonly inventoryRepository: InventoryRepository,
    private readonly orderService: OrderService,
    private readonly orderRepository: OrderRepository,
    private readonly addressesService: AddressesService,
    private readonly usersRepository: UsersRepository,
    private readonly shippingProvidersRepository: ShippingProvidersRepository,
    private readonly codAreasRepository: CodAreasRepository,
    private readonly checkoutQuotesRepository: CheckoutQuotesRepository,
    private readonly locationsService: AdministrativeLocationsService,
  ) {}

  async createQuote(
    userId: string,
    dto: CreateCheckoutQuoteDto,
  ): Promise<CheckoutQuoteResponseDto> {
    await this.requireUser(userId);

    return this.orderRepositoryTransaction(
      async (tx) => {
        const cart = await this.requireCartWithItems(userId, tx);
        const address = await this.requireOwnedAddress(
          userId,
          dto.addressId,
          tx,
        );
        const provider = await this.shippingProvidersRepository.findForCheckout(
          dto.shippingProviderId,
          tx,
        );

        if (provider === null) {
          throw new NotFoundException('Shipping provider not found');
        }
        if (!provider.isActive) {
          throw new ConflictException('Shipping provider is not active');
        }

        let administrativeLocationPath:
          | AdministrativeLocationResponseDto[]
          | null = null;
        if (dto.paymentMethod === 'COD') {
          if (!provider.supportsCod) {
            throw new ConflictException(
              'The selected shipping provider does not support COD. Choose ABA PayWay or another provider.',
            );
          }
          const path = await this.locationsService.assertCodEligible(
            address.administrativeLocationPcode,
            tx,
          );
          administrativeLocationPath = path.map(
            AdministrativeLocationResponseDto.fromEntity,
          );
        } else if (address.administrativeLocationPath !== null) {
          administrativeLocationPath = address.administrativeLocationPath;
        }

        const lines = this.cartLines(cart);
        await this.orderRepository.lockCheckoutCatalog(
          lines.map((line) => line.variantId),
          tx,
        );
        const resolved = await this.orderService.resolveOrderLines(lines, tx);
        await this.requireAvailableStock(resolved, tx);
        const subtotal = sumLineTotals(
          resolved.map((line) => line.lineTotal),
        );
        const shippingFee = new Prisma.Decimal(provider.baseFee);
        const discountAmount = new Prisma.Decimal(0);
        const totalAmount = calculateOrderTotal(
          subtotal,
          shippingFee,
          discountAmount,
        );
        const expiresAt = new Date(Date.now() + QUOTE_LIFETIME_MS);
        const addressSnapshot = this.addressSnapshot(address);
        const cartSnapshot = this.cartSnapshot(resolved);

        const quote = await this.checkoutQuotesRepository.create(
          {
            userId,
            addressId: address.id,
            addressSnapshot,
            shippingProviderId: provider.id,
            shippingProviderCode: provider.code,
            shippingProviderName: provider.name,
            codAreaId: null,
            codAreaCode: null,
            codAreaName: null,
            paymentMethod: dto.paymentMethod,
            cartSnapshot,
            subtotal: subtotal.toFixed(2),
            shippingFee: shippingFee.toFixed(2),
            discountAmount: discountAmount.toFixed(2),
            totalAmount: totalAmount.toFixed(2),
            currency: 'USD',
            expiresAt,
          },
          tx,
        );

        return CheckoutQuoteResponseDto.fromValues({
          quoteId: quote.id,
          paymentMethod: dto.paymentMethod,
          addressId: quote.addressId,
          provider,
          administrativeLocationPath,
          items: resolved,
          subtotal,
          shippingFee,
          discountAmount,
          totalAmount,
          currency: quote.currency,
          expiresAt,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  /**
   * Converts the caller's cart into an order and reserves the stock for it.
   *
   * @param userId The authenticated caller's id, from the verified access token.
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

    const hasLegacyAddress = dto.addressId !== undefined;
    const hasQuoteInput =
      dto.quoteId !== undefined || dto.idempotencyKey !== undefined;
    if (hasLegacyAddress === hasQuoteInput) {
      throw new BadRequestException(
        'Provide either addressId or both quoteId and idempotencyKey',
      );
    }
    if (
      hasLegacyAddress &&
      (dto.quoteId !== undefined || dto.idempotencyKey !== undefined)
    ) {
      throw new BadRequestException(
        'Legacy checkout cannot be combined with quote fields',
      );
    }
    if (
      !hasLegacyAddress &&
      (dto.quoteId === undefined || dto.idempotencyKey === undefined)
    ) {
      throw new BadRequestException(
        'quoteId and idempotencyKey are both required',
      );
    }

    if (!hasLegacyAddress) {
      const replay = await this.findIdempotentOrder(
        userId,
        dto.quoteId!,
        dto.idempotencyKey!,
      );
      if (replay !== null) return CheckoutResponseDto.fromOrder(replay);
    }

    // The retry loop is outside the transaction, deliberately. In PostgreSQL a
    // failed statement leaves the transaction aborted — every later statement in it
    // fails with "current transaction is aborted" — so the only way to retry is to
    // roll back and start again. Each attempt below is a whole, independent
    // transaction, and a failed attempt leaves no order, no stock hold and no
    // emptied cart behind it.
    for (let attempt = 1; attempt <= CHECKOUT_ATTEMPTS; attempt += 1) {
      const orderNumber = await this.orderService.drawOrderNumber();

      try {
        const transactionOptions = hasLegacyAddress
          ? undefined
          : { isolationLevel: Prisma.TransactionIsolationLevel.Serializable };
        const runCheckout = (tx: CheckoutTransactionClient) =>
          this.checkoutInTransaction(userId, dto, orderNumber, tx);
        const order =
          transactionOptions === undefined
            ? await this.orderRepositoryTransaction(runCheckout)
            : await this.orderRepositoryTransaction(
                runCheckout,
                transactionOptions,
              );

        return CheckoutResponseDto.fromOrder(order);
      } catch (error) {
        if (
          error instanceof CheckoutIdempotencyRaceError &&
          dto.quoteId !== undefined &&
          dto.idempotencyKey !== undefined
        ) {
          const replay = await this.findIdempotentOrder(
            userId,
            dto.quoteId,
            dto.idempotencyKey,
          );
          if (replay !== null) return CheckoutResponseDto.fromOrder(replay);
          throw new ConflictException(QUOTE_EXPIRED_MESSAGE);
        }

        if (attempt < CHECKOUT_ATTEMPTS && this.isRetryable(error)) {
          this.logger.warn(
            `Checkout lost a race and will be retried whole (attempt ${attempt} of ${CHECKOUT_ATTEMPTS})`,
          );
          continue;
        }

        if (
          !hasLegacyAddress &&
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          throw new ConflictException(
            'Idempotency key has already been used',
          );
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
    if (dto.quoteId !== undefined && dto.idempotencyKey !== undefined) {
      return this.checkoutFromQuoteInTransaction(
        userId,
        dto.quoteId,
        dto.idempotencyKey,
        orderNumber,
        tx,
      );
    }

    const cart = await this.requireCartWithItems(userId, tx);
    const address = await this.requireOwnedAddress(
      userId,
      dto.addressId!,
      tx,
    );
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

  private async checkoutFromQuoteInTransaction(
    userId: string,
    quoteId: string,
    idempotencyKey: string,
    orderNumber: string,
    tx: CheckoutTransactionClient,
  ): Promise<OrderWithItems> {
    const quote = await this.checkoutQuotesRepository.findForOwner(
      quoteId,
      userId,
      tx,
    );
    if (quote === null) throw new NotFoundException('Checkout quote not found');

    if (quote.consumedAt !== null) {
      if (
        quote.idempotencyKey === idempotencyKey &&
        quote.orderId !== null
      ) {
        const priorOrder = await this.orderRepository.findById(
          quote.orderId,
          tx,
        );
        if (priorOrder !== null && priorOrder.userId === userId) {
          return priorOrder;
        }
      }
      throw new ConflictException('Checkout quote has already been consumed');
    }
    if (quote.expiresAt.getTime() <= Date.now()) {
      throw new ConflictException(QUOTE_EXPIRED_MESSAGE);
    }

    const [cart, address, provider] = await Promise.all([
      this.requireCartWithItems(userId, tx, true),
      this.requireOwnedAddress(userId, quote.addressId, tx, true),
      this.shippingProvidersRepository.findForCheckout(
        quote.shippingProviderId,
        tx,
      ),
    ]);

    if (
      provider === null ||
      !provider.isActive ||
      provider.code !== quote.shippingProviderCode ||
      provider.name !== quote.shippingProviderName ||
      !new Prisma.Decimal(provider.baseFee).equals(quote.shippingFee)
    ) {
      throw new ConflictException(QUOTE_EXPIRED_MESSAGE);
    }
    const hasLocationSnapshot = this.addressSnapshotHasLocation(
      quote.addressSnapshot,
    );
    if (
      !this.jsonSnapshotsEqual(
        quote.addressSnapshot,
        this.addressSnapshot(address, hasLocationSnapshot),
      )
    ) {
      throw new ConflictException(QUOTE_EXPIRED_MESSAGE);
    }

    let codArea:
      | Awaited<ReturnType<CodAreasRepository['findById']>>
      | null = null;
    if (quote.paymentMethod === 'COD') {
      if (!provider.supportsCod) {
        throw new ConflictException(QUOTE_EXPIRED_MESSAGE);
      }
      if (quote.codAreaId !== null) {
        codArea = await this.codAreasRepository.findForCheckout(
          quote.codAreaId,
          tx,
        );
        if (
          codArea === null ||
          !codArea.codEnabled ||
          codArea.code !== quote.codAreaCode ||
          codArea.name !== quote.codAreaName
        ) {
          throw new ConflictException(QUOTE_EXPIRED_MESSAGE);
        }
      } else {
        if (!hasLocationSnapshot) {
          throw new ConflictException(QUOTE_EXPIRED_MESSAGE);
        }
        await this.locationsService.assertCodEligible(
          address.administrativeLocationPcode,
          tx,
        );
      }
    }

    const lines = this.cartLines(cart);
    await this.orderRepository.lockCheckoutCatalog(
      lines.map((line) => line.variantId),
      tx,
    );
    const resolved = await this.orderService.resolveOrderLines(lines, tx);
    if (
      !this.jsonSnapshotsEqual(
        quote.cartSnapshot,
        this.cartSnapshot(resolved),
      )
    ) {
      throw new ConflictException(QUOTE_EXPIRED_MESSAGE);
    }
    await this.requireAvailableStock(resolved, tx);

    const subtotal = sumLineTotals(resolved.map((line) => line.lineTotal));
    const totalAmount = calculateOrderTotal(
      subtotal,
      quote.shippingFee,
      quote.discountAmount,
    );
    if (
      !subtotal.equals(quote.subtotal) ||
      !totalAmount.equals(quote.totalAmount) ||
      quote.currency !== 'USD'
    ) {
      throw new ConflictException(QUOTE_EXPIRED_MESSAGE);
    }

    await this.reserveStockForLines(resolved, tx);
    const input = this.buildOrderInput(
      userId,
      address,
      lines,
    );
    input.shippingFee = quote.shippingFee.toFixed(2);
    input.discountAmount = quote.discountAmount.toFixed(2);
    input.currency = quote.currency;
    input.paymentMethod = quote.paymentMethod;
    input.shippingProviderId = provider.id;
    input.shippingProviderCode = provider.code;
    input.shippingProviderName = provider.name;
    input.codAreaId = codArea?.id ?? null;
    input.codAreaCode = codArea?.code ?? null;
    input.codAreaName = codArea?.name ?? null;

    const order = await this.orderService.writeOrder(
      input,
      resolved,
      orderNumber,
      tx,
    );
    await this.cartRepository.deleteItemsByCart(cart.id, tx);

    const consumed = await this.checkoutQuotesRepository.consume(
      quote.id,
      userId,
      idempotencyKey,
      order.id,
      tx,
    );
    if (consumed.count !== 1) {
      const current = await this.checkoutQuotesRepository.findForOwner(
        quote.id,
        userId,
        tx,
      );
      if (
        current?.idempotencyKey === idempotencyKey &&
        current.orderId !== null
      ) {
        throw new CheckoutIdempotencyRaceError();
      }
      throw new ConflictException(QUOTE_EXPIRED_MESSAGE);
    }

    return order;
  }

  private async findIdempotentOrder(
    userId: string,
    quoteId: string,
    idempotencyKey: string,
  ): Promise<OrderWithItems | null> {
    const quote =
      await this.checkoutQuotesRepository.findByIdempotencyKey(
        userId,
        idempotencyKey,
      );
    if (quote === null) return null;
    if (quote.id !== quoteId) {
      throw new ConflictException(
        'Idempotency key has already been used for another quote',
      );
    }
    if (quote.orderId === null) {
      throw new ConflictException('Checkout request is still being processed');
    }

    const order = await this.orderRepository.findById(quote.orderId);
    if (order === null || order.userId !== userId) {
      throw new ConflictException('The completed checkout could not be found');
    }
    return order;
  }

  private async requireAvailableStock(
    lines: ResolvedOrderLine[],
    tx: CheckoutTransactionClient,
  ): Promise<void> {
    for (const line of lines) {
      if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
        throw new BadRequestException(NON_POSITIVE_QUANTITY_MESSAGE);
      }
      const inventory = await this.inventoryRepository.findByVariantId(
        line.variantId,
        tx,
      );
      if (inventory === null) {
        throw new ConflictException(`${NOT_STOCKED_MESSAGE}: ${line.sku}`);
      }
      if (inventory.quantity - inventory.reservedQuantity < line.quantity) {
        throw new ConflictException(
          `${INSUFFICIENT_STOCK_MESSAGE}: ${line.sku}`,
        );
      }
    }
  }

  private addressSnapshot(
    address: AddressResponseDto,
    includeLocation = true,
  ): Prisma.InputJsonObject {
    const snapshot: Prisma.InputJsonObject = {
      recipientName: address.recipientName,
      phone: address.phone,
      addressLine1: address.addressLine1,
      addressLine2: address.addressLine2,
      city: address.city,
      stateProvince: address.stateProvince,
      postalCode: address.postalCode,
      countryCode: address.countryCode,
      ...(includeLocation
        ? {
            administrativeLocationPcode:
              address.administrativeLocationPcode,
          }
        : {}),
    };
    return snapshot;
  }

  private addressSnapshotHasLocation(snapshot: unknown): boolean {
    return (
      snapshot !== null &&
      typeof snapshot === 'object' &&
      !Array.isArray(snapshot) &&
      Object.prototype.hasOwnProperty.call(
        snapshot,
        'administrativeLocationPcode',
      )
    );
  }

  private cartSnapshot(
    lines: ResolvedOrderLine[],
  ): Prisma.InputJsonArray {
    return lines.map((line) => ({
      variantId: line.variantId,
      productName: line.productName,
      sku: line.sku,
      variantOptionsSnapshot: line.variantOptionsSnapshot,
      unitPrice: line.unitPrice.toFixed(2),
      quantity: line.quantity,
      lineTotal: line.lineTotal.toFixed(2),
    }));
  }

  private jsonSnapshotsEqual(left: unknown, right: unknown): boolean {
    const canonicalize = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(canonicalize);
      if (value !== null && typeof value === 'object') {
        return Object.fromEntries(
          Object.entries(value)
            .sort(([leftKey], [rightKey]) =>
              leftKey.localeCompare(rightKey),
            )
            .map(([key, item]) => [key, canonicalize(item)]),
        );
      }
      return value;
    };
    return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
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
    lockForCheckout = false,
  ): Promise<CartWithItems> {
    const cart = lockForCheckout
      ? await this.cartRepository.findForCheckout(userId, tx)
      : await this.cartRepository.findByUserId(userId, tx);

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
   * Quote-backed checkout supplies the persisted fee and payment/shipping snapshots
   * after this address snapshot is assembled. The compatibility path leaves those
   * fields unset and uses the existing zero-fee order defaults.
   */
  private buildOrderInput(
    userId: string,
    address: {
      recipientName: string;
      phone: string;
      addressLine1: string;
      addressLine2: string | null;
      city: string | null;
      stateProvince: string | null;
      administrativeLocationPcode: string | null;
      administrativeLocationPath: AdministrativeLocationResponseDto[] | null;
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
      administrativeLocationPcode: address.administrativeLocationPcode,
      administrativeLocationSnapshot:
        address.administrativeLocationPath?.map((location) => ({
          pcode: location.pcode,
          adminLevel: location.adminLevel,
          nameEn: location.nameEn,
          nameKm: location.nameKm,
        })),
    };

    return { userId, lines, shipping };
  }

  /**
   * Confirms the authenticated caller is a real user.
   *
   * `JwtAuthGuard` already resolved the bearer token to a real, active user, so this is
   * a second line of defence rather than the primary one. It runs before the transaction
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
    lockForCheckout = false,
  ) {
    if (lockForCheckout) {
      return tx
        .$queryRaw`
          SELECT "id" FROM "addresses"
          WHERE "id" = ${addressId}::uuid
            AND "user_id" = ${userId}::uuid
          FOR SHARE
        `
        .then(() => this.addressesService.findOne(userId, addressId, tx));
    }
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
    options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
  ): Promise<T> {
    return options === undefined
      ? this.cartRepository.runInTransaction((tx) => work(tx))
      : this.cartRepository.runInTransaction((tx) => work(tx), options);
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
