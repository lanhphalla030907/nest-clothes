-- CreateTable
CREATE TABLE "variant_options" (
    "id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "option_name" VARCHAR(50) NOT NULL,
    "option_value" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "variant_options_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "variant_options_variant_id_idx" ON "variant_options"("variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "variant_options_variant_id_option_name_key" ON "variant_options"("variant_id", "option_name");

-- A variant cannot carry the same axis twice, and "the same" is case-insensitive:
-- `Color` and `color` must collide. Prisma cannot express an expression index, so
-- the case-insensitive arm of the rule is declared here. Case is still preserved
-- in the stored value; this index is what enforces uniqueness rather than a
-- normalising write.
CREATE UNIQUE INDEX "variant_options_variant_id_option_name_ci_key" ON "variant_options"("variant_id", lower("option_name"));

-- AddForeignKey
ALTER TABLE "variant_options" ADD CONSTRAINT "variant_options_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
