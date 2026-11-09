-- AlterTable
ALTER TABLE "checkout_quotes" ADD COLUMN     "applied_promotions" JSONB,
ADD COLUMN     "coupon_code" VARCHAR(50);

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "coupon_code" VARCHAR(50);

-- CreateTable
CREATE TABLE "promotions" (
    "id" UUID NOT NULL,
    "code" VARCHAR(50),
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(500),
    "kind" VARCHAR(20) NOT NULL,
    "discount_type" VARCHAR(20) NOT NULL,
    "percent_off" DECIMAL(5,2),
    "amount_off" DECIMAL(12,2),
    "min_subtotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "max_discount" DECIMAL(12,2),
    "starts_at" TIMESTAMPTZ,
    "ends_at" TIMESTAMPTZ,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "usage_limit_total" INTEGER,
    "usage_limit_per_user" INTEGER,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "promotions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "promotion_usages" (
    "id" UUID NOT NULL,
    "promotion_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "code_snapshot" VARCHAR(50),
    "name_snapshot" VARCHAR(120) NOT NULL,
    "discount_type" VARCHAR(20) NOT NULL,
    "percent_off" DECIMAL(5,2),
    "amount_off" DECIMAL(12,2),
    "discount_amount" DECIMAL(12,2) NOT NULL,
    "subtotal_at_use" DECIMAL(12,2) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "promotion_usages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "promotions_code_key" ON "promotions"("code");

-- CreateIndex
CREATE INDEX "promotions_kind_is_active_starts_at_ends_at_idx" ON "promotions"("kind", "is_active", "starts_at", "ends_at");

-- CreateIndex
CREATE INDEX "promotions_archived_at_idx" ON "promotions"("archived_at");

-- CreateIndex
CREATE INDEX "promotion_usages_user_id_promotion_id_idx" ON "promotion_usages"("user_id", "promotion_id");

-- CreateIndex
CREATE INDEX "promotion_usages_promotion_id_created_at_id_idx" ON "promotion_usages"("promotion_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "promotion_usages_order_id_idx" ON "promotion_usages"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "promotion_usages_promotion_id_order_id_key" ON "promotion_usages"("promotion_id", "order_id");

-- AddForeignKey
ALTER TABLE "promotion_usages" ADD CONSTRAINT "promotion_usages_promotion_id_fkey" FOREIGN KEY ("promotion_id") REFERENCES "promotions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_usages" ADD CONSTRAINT "promotion_usages_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "promotion_usages" ADD CONSTRAINT "promotion_usages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Promotion rule constraints.
--
-- Prisma cannot express value sets or numeric bounds in the schema, so these are
-- declared here as the database-level backstop, matching the existing
-- `orders_*` and `order_items_*` constraints. Every rule the service will enforce
-- is stated once more in SQL so an interleaved or bypassed write cannot persist a
-- promotion that can never evaluate correctly.
ALTER TABLE "promotions"
  -- The value sets are deliberately strings, but only these values are accepted.
  ADD CONSTRAINT "promotions_kind_allowed"
    CHECK ("kind" IN ('COUPON', 'AUTOMATIC')),
  ADD CONSTRAINT "promotions_discount_type_allowed"
    CHECK ("discount_type" IN ('PERCENTAGE', 'FIXED_AMOUNT', 'FREE_SHIPPING')),

  -- Coupon codes are stored uppercase, per the case-insensitive lookup rule.
  ADD CONSTRAINT "promotions_code_uppercase"
    CHECK ("code" IS NULL OR "code" = upper("code")),
  -- A coupon is selected by its code; an automatic promotion is selected by the
  -- cart and therefore has no code.
  ADD CONSTRAINT "promotions_coupon_code_required"
    CHECK ("kind" != 'COUPON' OR "code" IS NOT NULL),
  ADD CONSTRAINT "promotions_automatic_code_absent"
    CHECK ("kind" != 'AUTOMATIC' OR "code" IS NULL),

  -- Each discount type owns exactly one value shape.
  ADD CONSTRAINT "promotions_percentage_shape"
    CHECK ("discount_type" != 'PERCENTAGE' OR
      ("percent_off" IS NOT NULL AND "percent_off" > 0 AND "percent_off" <= 100
       AND "amount_off" IS NULL)),
  ADD CONSTRAINT "promotions_fixed_amount_shape"
    CHECK ("discount_type" != 'FIXED_AMOUNT' OR
      ("amount_off" IS NOT NULL AND "amount_off" > 0 AND "percent_off" IS NULL)),
  ADD CONSTRAINT "promotions_free_shipping_shape"
    CHECK ("discount_type" != 'FREE_SHIPPING' OR
      ("percent_off" IS NULL AND "amount_off" IS NULL)),

  -- Money and limit bounds. A zero minimum spend is valid ("no threshold"); a
  -- zero or negative maximum discount or usage limit is not.
  ADD CONSTRAINT "promotions_min_subtotal_non_negative"
    CHECK ("min_subtotal" >= 0),
  ADD CONSTRAINT "promotions_max_discount_positive"
    CHECK ("max_discount" IS NULL OR "max_discount" > 0),
  ADD CONSTRAINT "promotions_usage_limit_total_non_negative"
    CHECK ("usage_limit_total" IS NULL OR "usage_limit_total" >= 0),
  ADD CONSTRAINT "promotions_usage_limit_per_user_non_negative"
    CHECK ("usage_limit_per_user" IS NULL OR "usage_limit_per_user" >= 0),

  -- Pause (`is_active`) and the scheduled window are independent, but when both
  -- ends of the window are present the window must be forward in time.
  ADD CONSTRAINT "promotions_validity_window"
    CHECK ("starts_at" IS NULL OR "ends_at" IS NULL OR "ends_at" > "starts_at");

-- The snapshots on existing tables carry a coupon code too, so they obey the same
-- uppercase rule as the promotion it came from. New columns are nullable, so no
-- existing row needs rewriting.
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_coupon_code_uppercase"
    CHECK ("coupon_code" IS NULL OR "coupon_code" = upper("coupon_code"));

ALTER TABLE "checkout_quotes"
  ADD CONSTRAINT "checkout_quotes_coupon_code_uppercase"
    CHECK ("coupon_code" IS NULL OR "coupon_code" = upper("coupon_code"));

-- The usage ledger is financial history, so its money must be non-negative even
-- if a writer bypasses the service. `discount_amount` may be zero when a
-- promotion evaluated but produced no deduction (for example a free-shipping rule
-- on an order whose provider fee is zero).
ALTER TABLE "promotion_usages"
  ADD CONSTRAINT "promotion_usages_code_snapshot_uppercase"
    CHECK ("code_snapshot" IS NULL OR "code_snapshot" = upper("code_snapshot")),
  ADD CONSTRAINT "promotion_usages_discount_amount_non_negative"
    CHECK ("discount_amount" >= 0),
  ADD CONSTRAINT "promotion_usages_subtotal_at_use_non_negative"
    CHECK ("subtotal_at_use" >= 0);
