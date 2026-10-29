ALTER TABLE "orders"
  ADD COLUMN "payment_method" VARCHAR(30),
  ADD COLUMN "shipping_provider_id" UUID,
  ADD COLUMN "shipping_provider_code" VARCHAR(50),
  ADD COLUMN "shipping_provider_name" VARCHAR(120),
  ADD COLUMN "cod_area_id" UUID,
  ADD COLUMN "cod_area_code" VARCHAR(50),
  ADD COLUMN "cod_area_name" VARCHAR(120);

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_payment_method_allowed"
    CHECK ("payment_method" IS NULL OR "payment_method" IN ('ABA_PAYWAY', 'COD')),
  ADD CONSTRAINT "orders_payment_shipping_snapshot_required"
    CHECK ("payment_method" IS NULL OR
      ("shipping_provider_id" IS NOT NULL
       AND "shipping_provider_code" IS NOT NULL
       AND "shipping_provider_name" IS NOT NULL)),
  ADD CONSTRAINT "orders_cod_area_snapshot_required"
    CHECK ("payment_method" != 'COD' OR
      ("cod_area_id" IS NOT NULL
       AND "cod_area_code" IS NOT NULL
       AND "cod_area_name" IS NOT NULL)),
  ADD CONSTRAINT "orders_non_cod_area_snapshot_absent"
    CHECK ("payment_method" != 'ABA_PAYWAY' OR
      ("cod_area_id" IS NULL AND "cod_area_code" IS NULL AND "cod_area_name" IS NULL)),
  ADD CONSTRAINT "orders_shipping_provider_fk"
    FOREIGN KEY ("shipping_provider_id") REFERENCES "shipping_providers"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "orders_cod_area_fk"
    FOREIGN KEY ("cod_area_id") REFERENCES "cod_areas"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "orders_shipping_provider_id_idx" ON "orders"("shipping_provider_id");
CREATE INDEX "orders_cod_area_id_idx" ON "orders"("cod_area_id");

CREATE TABLE "checkout_quotes" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "address_id" UUID NOT NULL,
  "address_snapshot" JSONB NOT NULL,
  "shipping_provider_id" UUID NOT NULL,
  "shipping_provider_code" VARCHAR(50) NOT NULL,
  "shipping_provider_name" VARCHAR(120) NOT NULL,
  "cod_area_id" UUID,
  "cod_area_code" VARCHAR(50),
  "cod_area_name" VARCHAR(120),
  "payment_method" VARCHAR(30) NOT NULL,
  "cart_snapshot" JSONB NOT NULL,
  "subtotal" DECIMAL(12,2) NOT NULL,
  "shipping_fee" DECIMAL(12,2) NOT NULL,
  "discount_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "total_amount" DECIMAL(12,2) NOT NULL,
  "currency" CHAR(3) NOT NULL DEFAULT 'USD',
  "expires_at" TIMESTAMPTZ NOT NULL,
  "consumed_at" TIMESTAMPTZ,
  "idempotency_key" VARCHAR(100),
  "order_id" UUID,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,

  CONSTRAINT "checkout_quotes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "checkout_quotes_user_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "checkout_quotes_order_fk"
    FOREIGN KEY ("order_id") REFERENCES "orders"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "checkout_quotes_payment_method_allowed"
    CHECK ("payment_method" IN ('ABA_PAYWAY', 'COD')),
  CONSTRAINT "checkout_quotes_non_negative_money"
    CHECK ("subtotal" >= 0 AND "shipping_fee" >= 0 AND "discount_amount" >= 0 AND "total_amount" >= 0),
  CONSTRAINT "checkout_quotes_total_consistent"
    CHECK ("total_amount" = "subtotal" + "shipping_fee" - "discount_amount"),
  CONSTRAINT "checkout_quotes_consumption_consistent"
    CHECK (("consumed_at" IS NULL AND "idempotency_key" IS NULL AND "order_id" IS NULL)
        OR ("consumed_at" IS NOT NULL AND "idempotency_key" IS NOT NULL AND "order_id" IS NOT NULL)),
  CONSTRAINT "checkout_quotes_cod_area_consistent"
    CHECK (("payment_method" = 'COD' AND "cod_area_id" IS NOT NULL AND "cod_area_code" IS NOT NULL AND "cod_area_name" IS NOT NULL)
        OR ("payment_method" = 'ABA_PAYWAY' AND "cod_area_id" IS NULL AND "cod_area_code" IS NULL AND "cod_area_name" IS NULL))
);

CREATE UNIQUE INDEX "checkout_quotes_user_idempotency_key_key"
  ON "checkout_quotes"("user_id", "idempotency_key");
CREATE UNIQUE INDEX "checkout_quotes_order_id_key"
  ON "checkout_quotes"("order_id");
CREATE INDEX "checkout_quotes_user_expires_at_idx"
  ON "checkout_quotes"("user_id", "expires_at");
