-- CreateTable
CREATE TABLE "product_attributes" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "attribute_name" VARCHAR(50) NOT NULL,
    "attribute_value" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "product_attributes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_attributes_product_id_idx" ON "product_attributes"("product_id");

-- A product cannot repeat the same attribute name, and "the same" is
-- case-insensitive: `Material` and `material` must collide. Prisma cannot express
-- a case-insensitive unique constraint, so the whole rule is declared here. Case
-- is preserved in the stored value; this index enforces uniqueness rather than a
-- normalising write.
CREATE UNIQUE INDEX "product_attributes_product_id_attribute_name_ci_key" ON "product_attributes"("product_id", lower("attribute_name"));

-- AddForeignKey
ALTER TABLE "product_attributes" ADD CONSTRAINT "product_attributes_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
