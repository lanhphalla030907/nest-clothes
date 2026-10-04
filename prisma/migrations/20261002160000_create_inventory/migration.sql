-- CreateTable
CREATE TABLE "inventory" (
    "id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "reserved_quantity" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "inventory_pkey" PRIMARY KEY ("id"),
    -- Stock counters may never go negative. Enforced here as the database-level
    -- backstop; the service also rejects negatives so the client gets a 400.
    CONSTRAINT "inventory_quantity_non_negative" CHECK ("quantity" >= 0),
    CONSTRAINT "inventory_reserved_quantity_non_negative" CHECK ("reserved_quantity" >= 0),
    -- Reserved stock is a promise against quantity, so it can never exceed it.
    -- This is the constraint that makes concurrent writers unable to persist an
    -- oversold row even if they both pass the service pre-check.
    CONSTRAINT "inventory_reserved_not_above_quantity" CHECK ("reserved_quantity" <= "quantity")
);

-- CreateIndex
-- One inventory row per variant, and the same index serves every
-- `WHERE variant_id = ...` lookup, so no separate non-unique index is created.
CREATE UNIQUE INDEX "inventory_variant_id_key" ON "inventory"("variant_id");

-- AddForeignKey
ALTER TABLE "inventory" ADD CONSTRAINT "inventory_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
