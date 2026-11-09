-- Variant purchase cost is internal catalogue data. Null means unknown; it is
-- deliberately not defaulted to zero.
ALTER TABLE "product_variants"
  ADD COLUMN "cost_price" DECIMAL(12,2),
  ADD COLUMN "cost_currency" CHAR(3),
  ADD COLUMN "cost_effective_at" TIMESTAMPTZ;

ALTER TABLE "product_variants"
  ADD CONSTRAINT "product_variants_cost_price_positive_check"
    CHECK ("cost_price" IS NULL OR "cost_price" > 0),
  ADD CONSTRAINT "product_variants_cost_currency_shape_check"
    CHECK ("cost_currency" IS NULL OR "cost_currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "product_variants_cost_fields_together_check"
    CHECK (("cost_price" IS NULL) = ("cost_currency" IS NULL));

CREATE TABLE "variant_cost_history" (
  "id" UUID NOT NULL,
  "variant_id" UUID NOT NULL,
  "cost" DECIMAL(12,2) NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "effective_from" TIMESTAMPTZ NOT NULL,
  "effective_to" TIMESTAMPTZ,
  "created_by_id" UUID,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "variant_cost_history_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "variant_cost_history_cost_positive_check" CHECK ("cost" > 0),
  CONSTRAINT "variant_cost_history_currency_shape_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "variant_cost_history_effective_range_check" CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from")
);

CREATE INDEX "variant_cost_history_variant_id_effective_from_id_idx"
  ON "variant_cost_history"("variant_id", "effective_from" DESC, "id" DESC);
CREATE INDEX "variant_cost_history_created_by_id_idx"
  ON "variant_cost_history"("created_by_id");
CREATE UNIQUE INDEX "variant_cost_history_one_current_per_variant"
  ON "variant_cost_history"("variant_id") WHERE "effective_to" IS NULL;

ALTER TABLE "variant_cost_history"
  ADD CONSTRAINT "variant_cost_history_variant_id_fkey"
    FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "variant_cost_history_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Existing order items stay deliberately uncosted. New checkouts populate these
-- fields atomically with their order line when an internal variant cost exists.
ALTER TABLE "order_items"
  ADD COLUMN "unit_cost_snapshot" DECIMAL(12,2),
  ADD COLUMN "cost_currency" CHAR(3),
  ADD COLUMN "cost_source" VARCHAR(30),
  ADD COLUMN "cost_captured_at" TIMESTAMPTZ;

ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_unit_cost_snapshot_positive_check"
    CHECK ("unit_cost_snapshot" IS NULL OR "unit_cost_snapshot" > 0),
  ADD CONSTRAINT "order_items_cost_currency_shape_check"
    CHECK ("cost_currency" IS NULL OR "cost_currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "order_items_cost_source_check"
    CHECK ("cost_source" IS NULL OR "cost_source" IN ('VARIANT_AT_ORDER', 'UNKNOWN')),
  ADD CONSTRAINT "order_items_cost_snapshot_consistency_check"
    CHECK (("unit_cost_snapshot" IS NULL) = ("cost_currency" IS NULL));
