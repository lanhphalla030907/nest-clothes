-- CreateTable
CREATE TABLE "carts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "carts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cart_items" (
    "id" UUID NOT NULL,
    "cart_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "cart_items_pkey" PRIMARY KEY ("id"),
    -- A line with no units is meaningless: the way to express "not wanted" is to
    -- delete the row, not to store zero. Enforced here as the database-level
    -- backstop; the service rejects a non-positive quantity first so the client
    -- gets a deterministic 400.
    CONSTRAINT "cart_items_quantity_positive" CHECK ("quantity" > 0)
);

-- CreateIndex
-- One cart per user, enforced by the database rather than by convention. This
-- also settles a concurrent first-request race: two simultaneous attempts to
-- create a cart for the same user cannot both succeed.
CREATE UNIQUE INDEX "carts_user_id_key" ON "carts"("user_id");

-- CreateIndex
-- Serves the reverse lookup "which carts reference this variant" and lets
-- Postgres check the foreign key without a sequential scan.
CREATE INDEX "cart_items_variant_id_idx" ON "cart_items"("variant_id");

-- CreateIndex
-- A variant appears at most once per cart. This index is also the whole lookup
-- path for a cart listing and for finding one variant's line within a cart, so
-- no separate non-unique index on `cart_id` is created.
CREATE UNIQUE INDEX "cart_items_cart_id_variant_id_key" ON "cart_items"("cart_id", "variant_id");

-- AddForeignKey
-- Deleting a user removes its cart, which in turn removes the cart's items:
-- both are owned exclusively by the user and are meaningless without it.
ALTER TABLE "carts" ADD CONSTRAINT "carts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_cart_id_fkey" FOREIGN KEY ("cart_id") REFERENCES "carts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- RESTRICT, not CASCADE. A line is a promise to a customer about a specific
-- purchasable variant, so a catalogue deletion must fail loudly instead of
-- silently emptying somebody's cart. The variant must be deactivated first.
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;