CREATE TABLE "shipping_providers" (
    "id" UUID NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "description" VARCHAR(500),
    "base_fee" DECIMAL(12,2) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "supports_cod" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "shipping_providers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "shipping_providers_code_canonical" CHECK ("code" ~ '^[A-Z0-9]+(-[A-Z0-9]+)*$'),
    CONSTRAINT "shipping_providers_name_non_blank" CHECK (length(btrim("name")) > 0),
    CONSTRAINT "shipping_providers_base_fee_non_negative" CHECK ("base_fee" >= 0)
);

CREATE UNIQUE INDEX "shipping_providers_code_key" ON "shipping_providers"("code");

CREATE INDEX "shipping_providers_is_active_name_idx"
  ON "shipping_providers"("is_active", "name");
