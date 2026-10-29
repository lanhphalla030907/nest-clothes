import {
  BadRequestException,
  ConflictException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { PaymentsService } from '../payments/payments.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { UsersRepository } from '../users/repositories/users.repository.js';
import {
  CANCELLABLE_ORDER_STATUSES,
  DEFAULT_ORDER_CURRENCY,
  DEFAULT_ORDER_STATUS,
  ORDER_STATUS,
  SHIPPABLE_ORDER_STATUS,
} from './constants/order-status.constants.js';
import { AdminOrderDetailResponseDto } from './dto/admin-order-detail-response.dto.js';
import { AdminOrderListQueryDto } from './dto/admin-order-list-query.dto.js';
import { AdminOrderListResponseDto } from './dto/admin-order-list-response.dto.js';
import { OrderResponseDto } from './dto/order-response.dto.js';
import { OrderSummaryResponseDto } from './dto/order-summary-response.dto.js';
import { OrderInventoryService } from './order-inventory.service.js';
import {
  MAX_CANDIDATE_ATTEMPTS,
  OrderNumberGenerator,
} from './order-number.generator.js';
import {
  OrderRepository,
  type OrderTransactionClient,
  type OrderWithItems,
} from './repositories/order.repository.js';
import {
  calculateLineTotal,
  calculateOrderTotal,
  InvalidMoneyValueError,
  sumLineTotals,
  toNonNegativeDecimal,
} from './utils/order-money.js';

const PRISMA_UNIQUE_CONSTRAINT_VIOLATION = 'P2002';
const ORDER_MODEL = 'Order';
const ORDER_NUMBER_FIELD = 'orderNumber';
const ORDER_NUMBER_COLUMN = 'order_number';

/**
 * How many times a write retries after losing the order-number race.
 *
 * Two concurrent orders can generate the same number; the `UNIQUE` constraint
 * rejects the loser, which then generates a fresh one. Three attempts against a
 * space of ~2.18 billion per day is not a probabilistic bound anyone should rely
 * on — it is here so the method is total rather than possibly retrying forever.
 */
const ORDER_NUMBER_ATTEMPTS = 3;

/**
 * A line as supplied by a caller placing an order.
 *
 * There is deliberately **no `unitPrice`**. A caller states what it wants and how
 * many; the price is read from the catalogue at write time. A price in the request
 * would be a client choosing what it pays, which is the single most important thing
 * this interface must not permit.
 */
export interface PlaceOrderLine {
  variantId: string;
  quantity: number;
}

/**
 * A shipping address as supplied at checkout.
 *
 * Copied onto the order rather than referenced from `addresses`; see
 * {@link OrderResponseDto} for why.
 */
export interface PlaceOrderShipping {
  recipientName: string;
  phone: string;
  addressLine1: string;
  addressLine2?: string | null;
  city: string | null;
  stateProvince?: string | null;
  administrativeLocationPcode?: string | null;
  administrativeLocationSnapshot?: Prisma.InputJsonArray;
  postalCode?: string | null;
  countryCode: string;
}

/**
 * Everything needed to write one order.
 *
 * Server-owned values used when writing an order. HTTP DTOs never expose monetary
 * amounts or snapshots directly; quote-backed checkout supplies them only after
 * validating the persisted quote in its transaction.
 */
export interface PlaceOrderInput {
  userId: string;
  lines: PlaceOrderLine[];
  shipping: PlaceOrderShipping;
  shippingFee?: unknown;
  discountAmount?: unknown;
  currency?: string;
  paymentMethod?: string | null;
  shippingProviderId?: string | null;
  shippingProviderCode?: string | null;
  shippingProviderName?: string | null;
  codAreaId?: string | null;
  codAreaCode?: string | null;
  codAreaName?: string | null;
}

/**
 * A line resolved against the catalogue and priced, ready to be written.
 *
 * Built once by {@link OrderService.resolveOrderLines} and then reused for both the
 * money arithmetic and the insert, so the totals are computed from exactly the
 * figures that get persisted. Recomputing from a second read would allow a total and
 * its lines to describe different moments.
 *
 * Exported because checkout resolves its lines and writes them as two separate
 * steps, with inventory reservation in between.
 */
export interface ResolvedOrderLine {
  variantId: string;
  productName: string;
  sku: string;
  variantOptionsSnapshot: { optionName: string; optionValue: string }[];
  unitPrice: Prisma.Decimal;
  quantity: number;
  lineTotal: Prisma.Decimal;
}

/**
 * All order business rules; the repository only knows SQL and the controller only
 * knows HTTP.
 *
 * ## What an order is
 *
 * A frozen record of a transaction. Three properties follow, and they explain
 * every decision in this service:
 *
 * **The totals are decided once.** `subtotal`, `shippingFee`, `discountAmount` and
 * `totalAmount` are computed with `Decimal` at write time and stored. An order
 * total is a quotation the customer accepted; deriving it from live prices would let
 * a later catalogue edit silently rewrite what somebody was charged. The arithmetic
 * lives in `utils/order-money.ts` and is mirrored by `CHECK` constraints in the
 * migration, so the two cannot drift apart.
 *
 * **Nothing points at mutable rows.** The shipping address and the product details
 * on each line are snapshots. Reading an old order must never show today's name or
 * today's price, and the only way to guarantee that is not to join.
 *
 * **Order numbers are unguessable.** Random rather than sequential, so one customer
 * cannot enumerate another's orders by counting — even though ownership is checked
 * on every read, a sequential number would still publish the shop's daily volume.
 *
 * ## Ownership
 *
 * Every read is scoped to the caller's identity, and "no such order" and "that
 * order belongs to somebody else" are the **same** 404, so the API never confirms
 * the existence of an order the caller may not see.
 *
 * ## Error semantics
 *
 * | Condition                                    | Status    | Rationale                                         |
 * | -------------------------------------------- | --------- | ------------------------------------------------- |
 * | Missing, malformed or expired token          | 401       | Rejected by `JwtAuthGuard`, before the service.   |
 * | Token whose user no longer exists           | 401       | Rejected by `JwtAuthGuard`, before the service.   |
 * | Malformed `:id` in the path                  | 400       | Rejected by `ParseUUIDPipe`, before the service.  |
 * | Order absent, or owned by another user       | 404       | Same 404, so ownership cannot be probed.           |
 * | Negative money value                         | 400       | `InvalidMoneyValueError`; also a `CHECK` below.    |
 * | Zero, negative or fractional line quantity   | 400       | `InvalidMoneyValueError`; also a `CHECK` below.    |
 * | Zero unit price                              | 400       | A free line is not a discount.                     |
 * | Discount larger than the goods               | 400       | Would make the total negative.                     |
 * | Empty basket at checkout                     | 400       | An order with no lines is not an order.            |
 * | Unknown variant in a line                    | 404       | The addressed resource is absent.                  |
 * | Variant exists but is inactive               | 400       | Valid id, but it cannot be sold.                   |
 * | Concurrent order-number collision            | (retried) | Regenerated; never surfaced.                       |
 *
 * A `CHECK` violation on write is *not* mapped to a 4xx. By then quantities and
 * money have already been validated, so a violation means the arithmetic itself is
 * wrong — a genuine fault that must surface as a 500 rather than invite a blind
 * retry.
 *
 * ## Nothing here is public yet
 *
 * {@link placeOrder} is internal: it is not on any controller, and no route
 * creates, modifies or cancels an order. Status, prices, totals, items and
 * snapshots are therefore unreachable from a client. That is the point of this
 * phase's boundary — the rules are written and tested now, and the checkout that
 * will call them arrives later, once money and stock handling are settled.
 */
@Injectable()
export class OrderService {
  private readonly logger = new Logger(OrderService.name);

  constructor(
    private readonly orderRepository: OrderRepository,
    private readonly usersRepository: UsersRepository,
    private readonly orderNumberGenerator: OrderNumberGenerator,
    private readonly orderInventory: OrderInventoryService,
    @Inject(forwardRef(() => PaymentsService))
    @Optional()
    private readonly paymentsService?: PaymentsService,
  ) {}

  /**
   * Returns the caller's orders, newest first.
   *
   * Empty is a success, not a 404: "this user has never ordered" is a normal state
   * for a listing to report, and a customer with no history should see an empty list
   * rather than an error.
   *
   * The claimed identity is verified first, so a header naming a deleted or
   * non-existent user fails as a 404 instead of returning an empty list that is
   * indistinguishable from "no orders yet".
   */
  async listOrders(userId: string): Promise<OrderSummaryResponseDto[]> {
    await this.requireUser(userId);

    const orders = await this.orderRepository.findByUserId(userId);

    if (this.paymentsService && orders.some((o) => o.status === ORDER_STATUS.PENDING)) {
      let anyPromoted = false;
      for (const order of orders) {
        if (order.status === ORDER_STATUS.PENDING) {
          const promoted = await this.paymentsService.verifyOrderPayment(order.id);
          if (promoted) anyPromoted = true;
        }
      }
      if (anyPromoted) {
        const refreshed = await this.orderRepository.findByUserId(userId);
        return refreshed.map((order) => OrderSummaryResponseDto.fromEntity(order));
      }
    }

    return orders.map((order) => OrderSummaryResponseDto.fromEntity(order));
  }

  /**
   * Returns one of the caller's orders with its items.
   *
   * Scoped to the caller: an order that exists but belongs to somebody else is
   * answered with the same 404 as an order that does not exist, so this endpoint
   * cannot be used to discover that a given order id is real.
   */
  async getOrder(userId: string, orderId: string): Promise<OrderResponseDto> {
    await this.requireUser(userId);

    let order = await this.requireOwnOrder(userId, orderId);

    if (order.status === ORDER_STATUS.PENDING && this.paymentsService) {
      const promoted = await this.paymentsService.verifyOrderPayment(order.id);
      if (promoted) {
        order = await this.requireOwnOrder(userId, orderId);
      }
    }

    return OrderResponseDto.fromEntity(order);
  }

  /**
   * Returns one page of every customer's orders, for an administrator.
   *
   * **Reached only from `GET /admin/orders`**, whose controller carries
   * `@Roles(Role.ADMIN)`. It is intentionally not scoped to a user: an operator
   * needs to see the whole shop, and the authorisation boundary is the route
   * rather than a filter.
   *
   * The date range is validated as two independently well-formed timestamps by
   * the DTO; their relative order is checked here because it is a cross-field
   * rule. `createdFrom` and `createdTo` are inclusive, which is what an operator
   * expects when they type a day boundary.
   */
  async listOrdersForAdmin(
    query: AdminOrderListQueryDto,
  ): Promise<AdminOrderListResponseDto> {
    const createdFrom = this.parseAdminDate(query.createdFrom, 'createdFrom');
    const createdTo = this.parseAdminDate(query.createdTo, 'createdTo');

    if (
      createdFrom !== undefined &&
      createdTo !== undefined &&
      createdFrom.getTime() > createdTo.getTime()
    ) {
      throw new BadRequestException(
        'createdFrom must not be later than createdTo',
      );
    }

    const search = query.search?.trim();

    const result = await this.orderRepository.findAdminPage({
      page: query.page,
      limit: query.limit,
      status: query.status,
      search: search === undefined || search.length === 0 ? undefined : search,
      createdFrom,
      createdTo,
    });

    return AdminOrderListResponseDto.fromResult(
      result,
      query.page,
      query.limit,
    );
  }

  /**
   * Returns any customer's order with its snapshots and payment attempts.
   *
   * A missing order is a 404. Unlike the customer route, there is no ownership
   * check: the caller's `ADMIN` role is what makes crossing that boundary legal,
   * and it is enforced by `RolesGuard` before this method is called.
   */
  async getOrderForAdmin(
    orderId: string,
  ): Promise<AdminOrderDetailResponseDto> {
    const order = await this.orderRepository.findAdminById(orderId);

    if (order === null) {
      throw this.orderNotFound(orderId);
    }

    return AdminOrderDetailResponseDto.fromEntity(order);
  }

  /**
   * Cancels an unpaid order and releases its inventory reservation exactly once.
   *
   * ## The rules
   *
   * The only cancellable state is `PENDING`, the state checkout writes before any
   * money is collected. A `CONFIRMED` order has a verified `PAID` payment and this
   * application has no refund workflow, so it is refused: cancelling it would keep
   * the customer's money while describing the order as abandoned. `PROCESSING`
   * and later states are refused for the same reason, and because they are not
   * reachable through any route in this application.
   *
   * A `PENDING` order that nevertheless has a `PAID` payment — a late callback
   * racing a cancellation — is also refused. The payment flow's own guard remains
   * unchanged; see the late-callback note in `OrderInventoryService` and the final
   * caveat below.
   *
   * ## Atomicity and concurrency
   *
   * Everything runs in the caller-owned transaction:
   *
   * 1. a read distinguishes an unknown order (404) from an unsupported state (409);
   * 2. the payment policy is checked;
   * 3. a **guarded** `PENDING -> CANCELLED` update claims the transition;
   * 4. only the winner releases the reservation.
   *
   * Two concurrent cancellations both read `PENDING`, but the second `UPDATE`
   * affects zero rows after the first commits, so it never reaches inventory. If
   * releasing either fails — missing stock, an incoherent row, insufficient
   * reservation — the exception propagates and the status update rolls back with it.
   *
   * ## Known limitation: a live QR and a late callback
   *
   * Cancelling a `PENDING` order does not expire an outstanding QR, because payment
   * expiry is not implemented in this application. PayWay may still collect that
   * payment after the cancellation. The existing callback handler will record the
   * payment as `PAID` but cannot confirm an order that is no longer `PENDING`; it
   * logs the mismatch. Stock is not moved a second time, but the collected money
   * needs manual reconciliation/refund. Fixing that requires a refund workflow and
   * is deliberately outside this phase.
   */
  cancelOrderForAdmin(orderId: string): Promise<AdminOrderDetailResponseDto> {
    return this.orderRepository.runInTransaction(async (tx) => {
      const order = await this.orderRepository.findStatusById(orderId, tx);

      if (order === null) {
        throw this.orderNotFound(orderId);
      }

      if (
        !CANCELLABLE_ORDER_STATUSES.some(
          (cancellable) => cancellable === order.status,
        )
      ) {
        throw new ConflictException(
          `Order ${orderId} is ${order.status} and cannot be cancelled`,
        );
      }

      if (await this.orderRepository.hasPaidPayment(orderId, tx)) {
        throw new ConflictException(
          `Order ${orderId} has a verified payment and cannot be cancelled without a refund`,
        );
      }

      const transitioned = await this.orderRepository.transitionStatus(
        orderId,
        order.status,
        ORDER_STATUS.CANCELLED,
        tx,
      );

      if (!transitioned) {
        throw this.transitionConflict(orderId);
      }

      // The reservation is derived from the persisted order lines inside
      // `OrderInventoryService`; the request body never supplies a quantity.
      await this.orderInventory.releaseReservedForOrder(orderId, tx);

      return this.readAdminOrder(orderId, tx);
    });
  }

  /**
   * Ships a paid, confirmed order and commits its reserved stock exactly once.
   *
   * ## The rules
   *
   * The only shippable state is `CONFIRMED`, written exclusively by the verified
   * PayWay callback after it has checked the transaction against the order's amount
   * and currency. Shipment additionally requires at least one `PAID` payment, so a
   * malformed or manually altered `CONFIRMED` order cannot ship without evidence
   * that money was collected. No refund, payment mutation or status assignment is
   * exposed here.
   *
   * ## Atomicity and concurrency
   *
   * The same pattern as cancellation: read for 404/409, check the payment policy,
   * claim `CONFIRMED -> SHIPPED` with a guarded update, then call
   * `commitReservedForOrder` on the same transaction. The guarded update is the
   * concurrency control; the preceding read is only there to give a precise error.
   * A repeated or losing request affects zero rows and is rejected before inventory
   * moves. An inventory failure rolls the status change back.
   */
  shipOrderForAdmin(orderId: string): Promise<AdminOrderDetailResponseDto> {
    return this.orderRepository.runInTransaction(async (tx) => {
      const order = await this.orderRepository.findStatusById(orderId, tx);

      if (order === null) {
        throw this.orderNotFound(orderId);
      }

      if (order.status !== SHIPPABLE_ORDER_STATUS) {
        throw new ConflictException(
          `Order ${orderId} is ${order.status} and cannot be shipped`,
        );
      }

      if (!(await this.orderRepository.hasPaidPayment(orderId, tx))) {
        throw new ConflictException(
          `Order ${orderId} has no verified payment and cannot be shipped`,
        );
      }

      const transitioned = await this.orderRepository.transitionStatus(
        orderId,
        order.status,
        ORDER_STATUS.SHIPPED,
        tx,
      );

      if (!transitioned) {
        throw this.transitionConflict(orderId);
      }

      await this.orderInventory.commitReservedForOrder(orderId, tx);

      return this.readAdminOrder(orderId, tx);
    });
  }

  /**
   * Writes one order with its lines, in a single transaction.
   *
   * **Not reachable from HTTP.** No controller method calls this and none should
   * until the checkout phase exists: without a payment step and a stock
   * reservation, a public route here would let anyone mint orders at catalogue
   * prices.
   *
   * What it does, and why each part belongs to the service rather than the
   * repository:
   *
   * - **Reads prices from the catalogue.** A caller supplies `variantId` and
   *   `quantity`; the price comes from `product_variants`. A price in the request
   *   body would be a client choosing what it pays.
   * - **Refuses an inactive variant.** A deactivated product is not sellable, and an
   *   order containing one would promise something the shop has withdrawn.
   * - **Computes every figure with `Decimal`.** `lineTotal = unitPrice × quantity`,
   *   `subtotal = SUM(lineTotal)` and
   *   `totalAmount = subtotal + shippingFee - discountAmount`, each through
   *   `utils/order-money.ts`. No float participates anywhere.
   * - **Rejects negative money and non-positive quantities before writing**, so the
   *   caller gets a deterministic 400 rather than a constraint violation. The
   *   `CHECK` constraints remain the backstop for interleaved writes.
   * - **Snapshots everything.** Each line copies `productName`, `sku`, the variant
   *   options and the price; the order copies the nine address fields. Nothing is
   *   referenced, so a later catalogue edit cannot rewrite history.
   * - **Generates a unique order number**, retrying if it loses the `UNIQUE` race.
   *
   * Each attempt runs in one transaction, so an order is never persisted with only
   * some of its lines, and a retried attempt rolls back completely before the next
   * one starts.
   */
  async placeOrder(input: PlaceOrderInput): Promise<OrderResponseDto> {
    await this.requireUser(input.userId);

    if (input.lines.length === 0) {
      throw new BadRequestException('Cannot place an order with no lines');
    }

    // The retry loop is *outside* the transaction, deliberately. In PostgreSQL a
    // failed statement leaves the transaction aborted — every subsequent statement
    // in it fails with "current transaction is aborted" — so the only way to retry
    // an insert that lost a `UNIQUE` race is to roll the transaction back and start
    // another one. Each attempt is therefore a whole, independent transaction, and a
    // failed attempt leaves nothing behind.
    for (let attempt = 1; attempt <= ORDER_NUMBER_ATTEMPTS; attempt += 1) {
      const orderNumber = await this.drawOrderNumber();

      try {
        return await this.orderRepository.runInTransaction(async (tx) => {
          const lines = await this.resolveOrderLines(input.lines, tx);
          const order = await this.writeOrder(input, lines, orderNumber, tx);

          return OrderResponseDto.fromEntity(order);
        });
      } catch (error) {
        if (
          attempt < ORDER_NUMBER_ATTEMPTS &&
          this.isOrderNumberCollision(error)
        ) {
          this.logger.warn(
            `Order number ${orderNumber} was taken concurrently; regenerating`,
          );
          continue;
        }

        // Every money and quantity rule in the write path raises
        // `InvalidMoneyValueError`, so this is the single point where "this input
        // was not acceptable" becomes a 400. Mapping it here rather than at each
        // call site means a new check cannot be added without remembering to
        // translate it, which is exactly how a validation failure becomes a 500.
        if (error instanceof InvalidMoneyValueError) {
          throw new BadRequestException(error.message);
        }

        throw error;
      }
    }

    /* c8 ignore next 3 -- every iteration above returns or throws */
    throw new BadRequestException(
      'Could not allocate a unique order number; retry the request',
    );
  }

  /**
   * Writes the order and its lines, from lines that were already resolved and
   * priced, inside a transaction the caller owns.
   *
   * Split from {@link resolveOrderLines} because checkout has to do something
   * between the two: hold stock. It resolves the lines, reserves inventory for them,
   * and only then writes — so that an order is never written for stock that was not
   * successfully held, and no stock is held for an order that was not written.
   * Because both steps take the caller's transaction client, that interleaving all
   * commits or all rolls back as one unit.
   *
   * `shippingFee` and `discountAmount` default to zero and `currency` to the order
   * default for the legacy checkout path. Quote-backed checkout provides the
   * server-stored shipping fee and currency explicitly.
   *
   * The order and its lines are written by a single nested `create`, so an order is
   * never observable without its contents.
   */
  async writeOrder(
    input: PlaceOrderInput,
    lines: ResolvedOrderLine[],
    orderNumber: string,
    tx: OrderTransactionClient,
  ): Promise<OrderWithItems> {
    const shippingFee = toNonNegativeDecimal(
      input.shippingFee ?? 0,
      'shippingFee',
    );
    const discountAmount = toNonNegativeDecimal(
      input.discountAmount ?? 0,
      'discountAmount',
    );
    const subtotal = sumLineTotals(lines.map((line) => line.lineTotal));
    const totalAmount = calculateOrderTotal(
      subtotal,
      shippingFee,
      discountAmount,
    );

    return this.orderRepository.createOrder(
      {
        userId: input.userId,
        orderNumber,
        status: DEFAULT_ORDER_STATUS,
        subtotal: subtotal.toFixed(2),
        shippingFee: shippingFee.toFixed(2),
        discountAmount: discountAmount.toFixed(2),
        totalAmount: totalAmount.toFixed(2),
        currency: input.currency ?? DEFAULT_ORDER_CURRENCY,
        paymentMethod: input.paymentMethod ?? null,
        shippingProviderId: input.shippingProviderId ?? null,
        shippingProviderCode: input.shippingProviderCode ?? null,
        shippingProviderName: input.shippingProviderName ?? null,
        codAreaId: input.codAreaId ?? null,
        codAreaCode: input.codAreaCode ?? null,
        codAreaName: input.codAreaName ?? null,
        shippingRecipientName: input.shipping.recipientName,
        shippingPhone: input.shipping.phone,
        shippingAddressLine1: input.shipping.addressLine1,
        shippingAddressLine2: input.shipping.addressLine2 ?? null,
        shippingCity: input.shipping.city,
        shippingStateProvince: input.shipping.stateProvince ?? null,
        shippingLocationPcode:
          input.shipping.administrativeLocationPcode ?? null,
        ...(input.shipping.administrativeLocationSnapshot === undefined
          ? {}
          : {
              shippingLocationSnapshot:
                input.shipping.administrativeLocationSnapshot,
            }),
        shippingPostalCode: input.shipping.postalCode ?? null,
        shippingCountryCode: input.shipping.countryCode,
        items: { create: lines.map(toOrderItemCreateInput) },
      },
      tx,
    );
  }

  /**
   * Resolves each requested line against the catalogue and prices it.
   *
   * Public because checkout calls it directly, inside the transaction that will also
   * reserve the stock and write the order. It is the first of the two halves of
   * placing an order that the caller sequences: resolve, then (reserve), then
   * {@link writeOrder}.
   *
   * Every line is resolved **inside** the caller's transaction, so the price a
   * variant had when the order was written is the price on the line: a catalogue
   * repricing that lands mid-checkout cannot produce a total that disagrees with its
   * own lines.
   *
   * A repeated `variantId` is allowed and produces repeated lines rather than being
   * merged. That is deliberate and is the one place an order differs from a cart:
   * two lines of the same variant may legitimately have been priced differently, so
   * merging them would erase a real historical fact. Nothing produces such an input
   * yet — checkout will.
   *
   * Every rejection here is an `InvalidMoneyValueError`, which
   * {@link placeOrder} turns into a 400. Reaching the database with a zero price or
   * a non-positive quantity would be a bug; the conversion keeps the response
   * deterministic instead of leaking a 500.
   */
  async resolveOrderLines(
    lines: PlaceOrderLine[],
    tx: OrderTransactionClient,
  ): Promise<ResolvedOrderLine[]> {
    const resolved: ResolvedOrderLine[] = [];

    for (const line of lines) {
      const variant = await this.requireSellableVariant(line.variantId, tx);
      const product = await this.requireProductForVariant(
        variant.productId,
        tx,
      );
      const unitPrice = toNonNegativeDecimal(variant.price, 'unitPrice');

      if (unitPrice.isZero()) {
        throw new BadRequestException(
          `Product variant ${line.variantId} has no price and cannot be ordered`,
        );
      }

      resolved.push({
        variantId: variant.id,
        productName: product.name,
        sku: variant.sku,
        variantOptionsSnapshot:
          await this.orderRepository.findVariantOptionsForSnapshot(
            variant.id,
            tx,
          ),
        unitPrice,
        quantity: line.quantity,
        lineTotal: calculateLineTotal(unitPrice, line.quantity),
      });
    }

    return resolved;
  }

  /**
   * Returns an order number that is not currently in use.
   *
   * The database pre-check here is an **optimisation, never a guarantee**. It runs
   * outside the transaction that will insert the number, so two callers can both pass
   * it before either writes; only the `UNIQUE` constraint settles that, and
   * {@link placeOrder} is what retries when it fires.
   *
   * Public because checkout draws its number the same way and retries the whole
   * transaction when the constraint rejects it. What the pre-check does buy is
   * that a collision which is *already visible* — the number was taken a moment ago —
   * costs a loop iteration rather than a rolled-back transaction.
   *
   * The loop bound ({@link MAX_CANDIDATE_ATTEMPTS}) makes this total rather than
   * possibly infinite; exhausting it returns a last-resort candidate for the insert
   * to accept or reject.
   */
  async drawOrderNumber(): Promise<string> {
    for (let attempt = 0; attempt < MAX_CANDIDATE_ATTEMPTS; attempt += 1) {
      const candidate = this.orderNumberGenerator.build();

      if (!(await this.orderRepository.existsOrderNumber(candidate))) {
        return candidate;
      }
    }

    return this.orderNumberGenerator.build();
  }

  /**
   * Confirms the claimed identity is a real user.
   *
   * `JwtAuthGuard` has already resolved the bearer token to a real, active user, so in
   * practice this is a second line of defence rather than the primary one. It stays
   * because a 404 from a query scoped by a non-existent id would be indistinguishable
   * from an id that is merely absent, and this turns the first case into a clear 404
   * before any query runs.
   */
  private async requireUser(userId: string): Promise<void> {
    const user = await this.usersRepository.findById(userId);

    if (user === null) {
      throw new NotFoundException(`User ${userId} does not exist`);
    }
  }

  /**
   * Turns one validated ISO-8601 query value into a `Date`.
   *
   * The DTO has already refused a malformed timestamp, so the `Number.isNaN`
   * branch only protects an internal caller that bypasses HTTP validation. It is
   * still a 400 rather than a 500: the value is caller-shaped input even when it
   * arrives through the service.
   */
  private parseAdminDate(
    value: string | undefined,
    field: string,
  ): Date | undefined {
    if (value === undefined) {
      return undefined;
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(
        `${field} must be a valid ISO-8601 timestamp`,
      );
    }

    return date;
  }

  /**
   * Returns the order only when the caller owns it, else 404.
   *
   * One message for "no such order" and "not your order", so neither is probeable.
   */
  private async requireOwnOrder(
    userId: string,
    orderId: string,
  ): Promise<OrderWithItems> {
    const order = await this.orderRepository.findById(orderId);

    if (order === null || order.userId !== userId) {
      throw this.orderNotFound(orderId);
    }

    return order;
  }

  /**
   * Loads a variant that may be sold: it must exist and be active.
   *
   * "Missing" and "inactive" are different facts and get different statuses — a 404
   * means fix the identifier, a 400 means this thing is not for sale right now.
   */
  private async requireSellableVariant(
    variantId: string,
    tx: OrderTransactionClient,
  ) {
    const variant = await this.orderRepository.findVariantForCheckout(
      variantId,
      tx,
    );

    if (variant === null) {
      throw new NotFoundException(
        `Product variant ${variantId} does not exist`,
      );
    }

    if (!variant.isActive) {
      throw new BadRequestException(
        `Product variant ${variantId} is not active and cannot be ordered`,
      );
    }

    return variant;
  }

  /**
   * Loads the product a variant belongs to, for the `productName` snapshot, and
   * confirms it is still on sale.
   *
   * A variant cannot exist without its product through the schema, so `null` here
   * means the catalogue was altered outside these migrations. It is reported rather
   * than papered over, because a line with a blank product name would be a silently
   * wrong order.
   *
   * The product's own `isActive` is checked as well as the variant's, because the
   * two are independent switches: a product can be withdrawn while its variants are
   * left enabled, and an order must not be placed for it. Checking only the variant
   * would let a withdrawn product keep selling through its remaining variants.
   */
  private async requireProductForVariant(
    productId: string,
    tx: OrderTransactionClient,
  ) {
    const product = await this.orderRepository.findProductForCheckout(
      productId,
      tx,
    );

    if (product === null) {
      throw new NotFoundException(
        `Product ${productId} for this variant does not exist`,
      );
    }

    if (!product.isActive) {
      throw new BadRequestException(
        `Product ${productId} is not active and cannot be ordered`,
      );
    }

    return product;
  }

  /**
   * Detects a unique violation on `orders.order_number`.
   *
   * Only that constraint can be hit by an insert here (`id` is a server-generated
   * UUID), so a `P2002` on `Order` *is* the order-number race. `meta.target` is
   * matched first because it names the constraint, and **both spellings** are
   * accepted: some engines report Prisma field names (`orderNumber`) and some
   * report database column names (`order_number`). Matching only one of them would
   * silently stop retrying on the other engine. The model name is the fallback for
   * the driver-adapter path, where Prisma populates no target at all.
   *
   * Public because checkout places orders too, and must retry a whole transaction —
   * never a statement inside an aborted one — on exactly the same condition.
   */
  isOrderNumberCollision(error: unknown): boolean {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== PRISMA_UNIQUE_CONSTRAINT_VIOLATION
    ) {
      return false;
    }

    const target = error.meta?.['target'];

    if (Array.isArray(target)) {
      return (
        target.includes(ORDER_NUMBER_FIELD) ||
        target.includes(ORDER_NUMBER_COLUMN)
      );
    }

    if (typeof target === 'string') {
      return (
        target === ORDER_NUMBER_FIELD ||
        target === ORDER_NUMBER_COLUMN ||
        target.includes(ORDER_NUMBER_COLUMN)
      );
    }

    return error.meta?.['modelName'] === ORDER_MODEL;
  }

  /** One message for "no such order" and "not your order". */
  private orderNotFound(orderId: string): NotFoundException {
    return new NotFoundException(`Order ${orderId} does not exist`);
  }

  /** A concurrent writer won between the read and the guarded status update. */
  private transitionConflict(orderId: string): ConflictException {
    return new ConflictException(
      `Order ${orderId} changed state before the transition could be applied`,
    );
  }

  /** Reads the updated order through the administrative safe projection. */
  private async readAdminOrder(
    orderId: string,
    tx: OrderTransactionClient,
  ): Promise<AdminOrderDetailResponseDto> {
    const updated = await this.orderRepository.findAdminById(orderId, tx);

    if (updated === null) {
      throw this.orderNotFound(orderId);
    }

    return AdminOrderDetailResponseDto.fromEntity(updated);
  }
}

/**
 * Every status a test or a future phase may write into an order.
 *
 * Exposed from the service so a fixture cannot drift from the constants, and so a
 * test that needs a non-`PENDING` status — to prove the read path does not assume
 * `PENDING` — has a sanctioned way to name one.
 */
export { ORDER_STATUS };

/** Projects a resolved line into the nested `items.create` write shape. */
function toOrderItemCreateInput(line: ResolvedOrderLine) {
  return {
    variantId: line.variantId,
    productName: line.productName,
    sku: line.sku,
    variantOptionsSnapshot: line.variantOptionsSnapshot,
    unitPrice: line.unitPrice.toFixed(2),
    quantity: line.quantity,
    lineTotal: line.lineTotal.toFixed(2),
  };
}
