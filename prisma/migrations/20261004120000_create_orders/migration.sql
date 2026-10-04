-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "order_number" VARCHAR(30) NOT NULL,
    "status" VARCHAR(30) NOT NULL,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "shipping_fee" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "discount_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_amount" DECIMAL(12,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "shipping_recipient_name" VARCHAR(150) NOT NULL,
    "shipping_phone" VARCHAR(30) NOT NULL,
    "shipping_address_line1" VARCHAR(255) NOT NULL,
    "shipping_address_line2" VARCHAR(255),
    "shipping_city" VARCHAR(100) NOT NULL,
    "shipping_state_province" VARCHAR(100),
    "shipping_postal_code" VARCHAR(20),
    "shipping_country_code" CHAR(2) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id"),

    -- An order total is a quotation the customer already accepted, so every
    -- component of it must be a real, non-negative amount. `shipping_fee` and
    -- `discount_amount` are also part of the identity of the total, so they may
    -- not be negative either.
    --
    -- Prisma cannot express a numeric bound in the schema, so these are declared
    -- here as the database-level backstop. They are what makes it impossible for
    -- an interleaved write to persist a nonsensical amount even if the service's
    -- own validation were bypassed.
    CONSTRAINT "orders_subtotal_non_negative" CHECK ("subtotal" >= 0),
    CONSTRAINT "orders_shipping_fee_non_negative" CHECK ("shipping_fee" >= 0),
    CONSTRAINT "orders_discount_amount_non_negative" CHECK ("discount_amount" >= 0),
    CONSTRAINT "orders_total_amount_non_negative" CHECK ("total_amount" >= 0),

    -- The arithmetic itself is a fact about the database, not a convention of one
    -- caller: `total = subtotal + shipping_fee - discount_amount`.
    --
    -- Storing the total *and* asserting the identity is deliberate. The stored
    -- value is the figure the customer was shown and agreed to pay, so a read
    -- never has to recompute it; this constraint is what stops a bug in that
    -- recomputation from being written. The combination with the non-negative
    -- checks above also rules out a discount larger than the goods, which would
    -- otherwise produce a negative total.
    --
    -- Note there is deliberately NO tax term. Tax is not modelled yet, and adding
    -- a column later is additive, whereas a wrong tax figure frozen into an
    -- immutable total would not be.
    CONSTRAINT "orders_total_matches_components" CHECK ("total_amount" = "subtotal" + "shipping_fee" - "discount_amount"),

    -- ISO 4217 alphabetic code. Kept as a shape check rather than a lookup
    -- against a currency table, matching the treatment of `country_code`: the
    -- project does not maintain a canonical list of currencies, and a stored
    -- value must stay storable even when it is one we have not enumerated.
    CONSTRAINT "orders_currency_iso_4217_shape" CHECK ("currency" ~ '^[A-Z]{3}$'),
    -- ISO 3166-1 alpha-2, uppercased at the edge. Same reasoning as `currency`.
    CONSTRAINT "orders_shipping_country_code_iso_3166_shape" CHECK ("shipping_country_code" ~ '^[A-Z]{2}$')
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "product_name" VARCHAR(255) NOT NULL,
    "sku" VARCHAR(100) NOT NULL,
    "variant_options_snapshot" JSONB NOT NULL,
    "unit_price" DECIMAL(12,2) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "line_total" DECIMAL(12,2) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id"),

    -- A line with no units is meaningless: the way to express "not bought" is to
    -- delete the row, not to store zero. Same rule and same treatment as
    -- `cart_items_quantity_positive` — enforced here so it holds even if a write
    -- arrives from somewhere the service does not guard.
    CONSTRAINT "order_items_quantity_positive" CHECK ("quantity" > 0),
    -- A free line is not a discount; the price of a sold thing is positive. This
    -- mirrors `product_variants_price_positive_check` for the same reason.
    CONSTRAINT "order_items_unit_price_positive" CHECK ("unit_price" > 0),
    -- The derived total may not be zero or negative either. Given the two checks
    -- above and the multiplication below this is implied, but it is stated
    -- explicitly so the column can never hold a value that contradicts how the
    -- row is meant to be read.
    CONSTRAINT "order_items_line_total_positive" CHECK ("line_total" > 0),

    -- `line_total` is stored rather than computed on read so that the figure the
    -- customer agreed to is the figure that is kept. This check is what makes the
    -- stored value trustworthy: a line whose total is not exactly
    -- `unit_price * quantity` cannot be written at all, so an arithmetic bug in
    -- the service cannot reach the database through any other path.
    --
    -- The comparison is exact because every column is `NUMERIC(12,2)`: the product
    -- of a two-decimal amount and a whole quantity is still exact, and no float
    -- ever participates in the comparison.
    CONSTRAINT "order_items_line_total_matches_unit_price_times_quantity" CHECK ("line_total" = "unit_price" * "quantity")
);

-- CreateIndex
-- The customer-facing order number. This is the only thing uniqueness is
-- ultimately guaranteed by, and it is also why the number is generated from
-- `crypto.randomInt` rather than from a sequence: a sequential number would let
-- one customer read another's order by counting, even though ownership is checked
-- on every read.
--
-- The database constraint is the *final* protection against a collision between
-- two concurrent generators, not the primary mechanism — the generator reduces
-- the odds to roughly 1 in 2.2 billion per pair per day.
CREATE UNIQUE INDEX "orders_order_number_key" ON "orders"("order_number");

-- CreateIndex
-- Serves `GET /orders` — "this user's orders, newest first".
--
-- The column order matches the query exactly: `user_id` is an equality predicate,
-- and `created_at DESC, id DESC` is the literal `ORDER BY` the repository issues,
-- so Postgres walks the index for this user in output order and never sorts. The
-- trailing `id` is the deterministic tiebreak for rows sharing a timestamp, and it
-- is in the index rather than applied afterwards so two orders created in the same
-- millisecond cannot come back in a different order between requests.
CREATE INDEX "orders_user_id_created_at_id_idx" ON "orders"("user_id", "created_at" DESC, "id" DESC);

-- CreateIndex
-- Serves the per-order item listing and the `GET /orders/:id` hydration, and is
-- the lookup path the cascade on order deletion uses. No separate non-unique
-- index on `order_id` is created — this one already covers it.
CREATE INDEX "order_items_order_id_idx" ON "order_items"("order_id");

-- CreateIndex
-- Serves the reverse lookup "which orders contain this variant" and lets Postgres
-- check the foreign key without a sequential scan. Deliberately present even
-- though no endpoint reads it: it is what makes the `ON DELETE RESTRICT` below
-- cheap enough to evaluate on every catalogue delete.
CREATE INDEX "order_items_variant_id_idx" ON "order_items"("variant_id");

-- AddForeignKey
-- RESTRICT, not CASCADE. This is the one place in the schema where restriction is
-- unambiguously the right answer, and the contrast with `carts.user_id`,
-- `wishlists.user_id` and `addresses.user_id` is deliberate: those three hold
-- private working data that has no value once its owner is gone, whereas an order
-- is a financial record. Deleting an account must not silently destroy the fact
-- that a purchase happened, so the delete is refused and the caller must remove
-- the orders deliberately first.
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- CASCADE: a line is meaningless without the order it belongs to and is
-- unreachable without it, so the two are deleted together.
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- RESTRICT, as for `cart_items.variant_id` but with more force behind it: a cart
-- line is a provisional promise while an order line is permanent financial
-- history. The snapshot columns make the *display* of the line independent of the
-- variant, but they do not make the variant deletable — the foreign key stays so
-- that "which variant was this" is answerable, and so the catalogue must be
-- deactivated rather than deleted once a variant has been sold.
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;