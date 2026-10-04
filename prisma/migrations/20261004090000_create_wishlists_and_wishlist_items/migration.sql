-- CreateTable
CREATE TABLE "wishlists" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "wishlists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wishlist_items" (
    "id" UUID NOT NULL,
    "wishlist_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wishlist_items_pkey" PRIMARY KEY ("id")
    -- No `updated_at`: a saved item has nothing to edit. It is either saved or it
    -- is not, so an updated timestamp would only ever echo `created_at`. No
    -- `quantity` either — a wishlist records that a product is wanted, never how
    -- many of it; that is a cart decision.
);

-- CreateIndex
-- One wishlist per user, enforced by the database rather than by convention. It
-- also settles a concurrent first-request race: two simultaneous attempts to
-- create a wishlist for the same user cannot both succeed, so the loser can be
-- retried as a lookup and the caller never sees the conflict.
CREATE UNIQUE INDEX "wishlists_user_id_key" ON "wishlists"("user_id");

-- CreateIndex
-- A product appears at most once per wishlist, and saving it twice is a no-op
-- rather than a second row. This index is also the whole lookup path for a
-- wishlist listing and for finding one product's entry within a wishlist, so no
-- separate non-unique index on `wishlist_id` is created.
CREATE UNIQUE INDEX "wishlist_items_wishlist_id_product_id_key" ON "wishlist_items"("wishlist_id", "product_id");

-- CreateIndex
-- Serves the reverse lookup "which wishlists reference this product" and lets
-- Postgres check the foreign key without a sequential scan.
CREATE INDEX "wishlist_items_product_id_idx" ON "wishlist_items"("product_id");

-- AddForeignKey
-- Deleting a user removes its wishlist, which in turn removes the wishlist's
-- items: both are owned exclusively by the user and are meaningless without it.
ALTER TABLE "wishlists" ADD CONSTRAINT "wishlists_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wishlist_items" ADD CONSTRAINT "wishlist_items_wishlist_id_fkey" FOREIGN KEY ("wishlist_id") REFERENCES "wishlists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- RESTRICT, not CASCADE, for the same reason `cart_items.variant_id` restricts:
-- a saved product is a statement a customer made about something they want. A
-- catalogue deletion must fail loudly instead of silently altering it, so the
-- product has to be deactivated (`is_active = false`) first and removed only
-- once nobody has saved it.
ALTER TABLE "wishlist_items" ADD CONSTRAINT "wishlist_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
