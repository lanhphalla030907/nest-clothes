-- AlterTable
ALTER TABLE "product_variants" ADD COLUMN     "combination_key" VARCHAR(64);

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "options_revision" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "product_options" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "product_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_option_values" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "product_option_id" UUID NOT NULL,
    "value" VARCHAR(100) NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "product_option_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "variant_option_values" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "product_option_id" UUID NOT NULL,
    "option_value_id" UUID NOT NULL,

    CONSTRAINT "variant_option_values_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_options_product_id_position_id_idx" ON "product_options"("product_id", "position", "id");

-- CreateIndex
CREATE UNIQUE INDEX "product_options_product_id_lower_name_key" ON "product_options"("product_id", LOWER("name"));

-- CreateIndex
CREATE UNIQUE INDEX "product_options_id_product_id_key" ON "product_options"("id", "product_id");

-- CreateIndex
CREATE INDEX "product_option_values_product_option_id_position_id_idx" ON "product_option_values"("product_option_id", "position", "id");

-- CreateIndex
CREATE UNIQUE INDEX "product_option_values_product_option_id_lower_value_key" ON "product_option_values"("product_option_id", LOWER("value"));

-- CreateIndex
CREATE UNIQUE INDEX "product_option_values_id_product_option_id_product_id_key" ON "product_option_values"("id", "product_option_id", "product_id");

-- CreateIndex
CREATE INDEX "variant_option_values_option_value_id_product_id_idx" ON "variant_option_values"("option_value_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "variant_option_values_variant_id_product_option_id_key" ON "variant_option_values"("variant_id", "product_option_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_variants_id_product_id_key" ON "product_variants"("id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_variants_product_id_combination_key_key" ON "product_variants"("product_id", "combination_key");

-- AddForeignKey
ALTER TABLE "product_options" ADD CONSTRAINT "product_options_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_option_values" ADD CONSTRAINT "product_option_values_product_option_id_product_id_fkey" FOREIGN KEY ("product_option_id", "product_id") REFERENCES "product_options"("id", "product_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_option_values" ADD CONSTRAINT "variant_option_values_variant_id_product_id_fkey" FOREIGN KEY ("variant_id", "product_id") REFERENCES "product_variants"("id", "product_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_option_values" ADD CONSTRAINT "variant_option_values_option_value_id_product_option_id_pr_fkey" FOREIGN KEY ("option_value_id", "product_option_id", "product_id") REFERENCES "product_option_values"("id", "product_option_id", "product_id") ON DELETE RESTRICT ON UPDATE CASCADE;
