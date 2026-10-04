-- CreateTable
CREATE TABLE "addresses" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "label" VARCHAR(50) NOT NULL,
    "recipient_name" VARCHAR(150) NOT NULL,
    "phone" VARCHAR(30) NOT NULL,
    "address_line1" VARCHAR(255) NOT NULL,
    "address_line2" VARCHAR(255),
    "city" VARCHAR(100) NOT NULL,
    "state_province" VARCHAR(100),
    "postal_code" VARCHAR(20),
    "country_code" CHAR(2) NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "addresses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Serves the address book listing ("every address for this user"), the foreign
-- key check when a user is deleted, and the scans that move the default address
-- around. No index on `is_default` is added: the partial unique index below
-- already answers "which address is this user's default", and a user holds a
-- handful of addresses, so the listing touches a negligible number of rows
-- whatever order they come back in.
CREATE INDEX "addresses_user_id_idx" ON "addresses"("user_id");

-- CreateIndex
-- A user may hold many addresses but only ONE may be the default, so a checkout
-- can always fill itself without asking which address to use.
--
-- This is a *partial* unique index rather than a plain UNIQUE(user_id,
-- is_default) because the latter would also forbid two non-default addresses:
-- `false` would collide with itself, and a user with three saved addresses could
-- not save the second one. The predicate restricts uniqueness to the rows that
-- actually matter -- the default -- while leaving ordinary addresses unconstrained.
--
-- The index is also what makes the rule safe under concurrency. Two requests that
-- each try to become the default cannot both win: the loser's write is rejected
-- here rather than producing two defaults, and `AddressesService` retries it as a
-- fresh read-modify-write instead of surfacing an error.
--
-- Prisma cannot express a predicate on a unique constraint, so the index is
-- written here instead of being declared with @@unique in schema.prisma.
-- Consequently Prisma does not know about it: `prisma migrate dev` will not
-- recreate it if this migration is ever rolled back by hand, and `db pull` will
-- not report it. Re-add it here if the table is ever rebuilt.
CREATE UNIQUE INDEX "addresses_one_default_per_user_key" ON "addresses"("user_id") WHERE "is_default" = true;

-- AddForeignKey
-- CASCADE, like `carts.user_id` and `wishlists.user_id`: an address is owned
-- exclusively by its user and is meaningless without it.
--
-- Note the contrast with `wishlist_items.product_id`, which is RESTRICT. Nothing
-- durable points at an address yet, and orders deliberately will not: an order
-- snapshots the address it shipped to rather than referencing this mutable row,
-- so that editing an address never rewrites the delivery history of a past order.
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
