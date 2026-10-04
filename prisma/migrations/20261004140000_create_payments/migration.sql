-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "provider" VARCHAR(30) NOT NULL,
    "transaction_id" VARCHAR(20) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "payment_method" VARCHAR(50),
    "provider_reference" VARCHAR(100),
    "paid_at" TIMESTAMPTZ,
    "qr_payload" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id"),

    -- A payment attempt for nothing is meaningless, and an amount of zero would
    -- be indistinguishable from "the provider never told us" when a callback is
    -- verified. Same rule and same treatment as `order_items_unit_price_positive`.
    CONSTRAINT "payments_amount_positive" CHECK ("amount" > 0),

    -- ISO 4217 alphabetic code, uppercased at the edge. Identical reasoning and
    -- identical wording to `orders_currency_iso_4217_shape`: this is a shape check,
    -- not a lookup against a currency table the project does not maintain.
    --
    -- It is worth restating *why* the currency is stored at all when it is copied
    -- from the order: the payment's currency is the currency that was actually
    -- demanded of the customer, verified against the provider on the callback. If
    -- it were only ever read through `order_id`, that verification would have
    -- nothing to compare against.
    CONSTRAINT "payments_currency_iso_4217_shape" CHECK ("currency" ~ '^[A-Z]{3}$'),

    -- `paid_at` and `PAID` are written by the same statement and mean the same
    -- thing, so the database refuses to hold one without the other. Without this,
    -- a payment could be recorded as collected with no time it was collected, or
    -- carry a settlement time while still reading as unpaid — and the second of
    -- those is exactly the state in which a support agent cannot tell a paid order
    -- from an unpaid one.
    --
    -- This is an internal-consistency constraint, not an enumeration, which is why
    -- it belongs here while `status` itself is not constrained: see below.
    CONSTRAINT "payments_paid_at_matches_status" CHECK (("status" = 'PAID') = ("paid_at" IS NOT NULL))

    -- There is deliberately NO CHECK on `status` or `provider` enumerating their
    -- allowed values, mirroring the treatment of `orders.status`, `users.status`
    -- and `products.status`: those columns are free-form so that adding a state is
    -- not a migration, and the vocabulary lives in `payment-status.constants.ts`.
    --
    -- The argument for constraining a payment status is that the partial unique
    -- index below is keyed on the literal 'PENDING', so a misspelled status would be
    -- invisible to it. That risk is answered where it belongs — by the generator and
    -- the service writing only the constants — rather than by a constraint that
    -- would have to be dropped and recreated to add `REFUNDED` when refunds arrive.
    --
    -- Note what is *not* constrained either: `amount`, `currency` and `provider` are
    -- all copied from the order and the configuration rather than accepted from a
    -- request, and this table holds no credential of any kind.
);

-- CreateIndex
-- The provider's transaction identifier is how a callback names a payment, and how
-- a retry proves it is not a replay. Uniqueness across all providers (not
-- `(provider, transaction_id)`) is deliberate: PayWay treats `tran_id` as globally
-- unique, and a composite key would let two providers mint the same id and leave
-- the callback unable to tell which payment it was talking about.
--
-- `VARCHAR(20)` is PayWay's documented maximum for `tran_id`, so this index also
-- bounds how long a transaction id may be before the column refuses it.
CREATE UNIQUE INDEX "payments_transaction_id_key" ON "payments"("transaction_id");

-- CreateIndex
-- Serves an order's payments, newest first, and lets Postgres check the foreign
-- key without a sequential scan. The column order matches the repository's
-- `ORDER BY` (`created_at DESC, id DESC`) so the listing is walked from the index
-- and never sorted, with `id` as the same deterministic tiebreak the orders index
-- uses for rows sharing a timestamp.
CREATE INDEX "payments_order_id_created_at_id_idx" ON "payments"("order_id", "created_at" DESC, "id" DESC);

-- CreateIndex
-- The idempotency guarantee for `POST /orders/:orderId/payments`, and the single
-- most important index in this migration.
--
-- An order may be paid for many times over its life — an expired QR, a declined
-- card, a retry after a provider outage — but only **one** of those attempts may be
-- active at a time. This partial unique index is what makes that true: it is
-- impossible to store two `PENDING` payments for one order, no matter how many
-- requests arrive at once.
--
-- A plain `UNIQUE (order_id)` could not express this, and would be wrong twice
-- over: it would forbid the retry that the 1:N relation exists to allow, and it
-- would forbid it for exactly the orders that had already succeeded. Restricting
-- the index to `status = 'PENDING'` is what makes the constraint describe an
-- *active* attempt rather than an attempt at all.
--
-- Being partial is also what lets a failed attempt be recorded and then abandoned:
-- moving a row out of `PENDING` removes it from the index and frees the order for
-- the next attempt, with the failed row kept as history.
--
-- This is the backstop, not the mechanism. The service checks for an existing
-- pending payment first so the common case answers from a read, and this index is
-- what settles the race between two such checks — the loser gets a unique
-- violation (`P2002` on `payments_one_pending_per_order_key`) and re-reads the
-- winner's row rather than creating a second one.
--
-- It is not expressible in the Prisma schema: Prisma has no partial indexes.
CREATE UNIQUE INDEX "payments_one_pending_per_order_key" ON "payments"("order_id") WHERE "status" = 'PENDING';

-- AddForeignKey
-- RESTRICT, for the same reason as `orders.user_id` and `order_items.variant_id`.
-- A payment is financial history: the fact that money was or was not collected for
-- an order must not be erasable by deleting the order, and the provider's own record
-- of the transaction does not go away when a row here does. An order that has been
-- paid for therefore cannot be deleted — deliberately, and with the same trade-off
-- already accepted for orders.
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
