-- CreateTable
CREATE TABLE "product_images" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "image_url" VARCHAR(2048) NOT NULL,
    "public_id" VARCHAR(255) NOT NULL,
    "alt_text" VARCHAR(255),
    "sort_order" INTEGER NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "product_images_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_images_product_id_idx" ON "product_images"("product_id");

-- CreateIndex
CREATE INDEX "product_images_product_id_sort_order_idx" ON "product_images"("product_id", "sort_order");

-- CreateIndex
-- Partial unique index: a product may have MANY images but only ONE primary.
--
-- A plain UNIQUE ("product_id") would wrongly cap a product at a single image,
-- and no application-level check is enough on its own — two concurrent requests
-- can both observe "no primary exists" and both insert one. This constraint is
-- what actually settles that race: the second insert fails rather than silently
-- producing two primaries.
--
-- Prisma cannot express a predicate on a unique constraint, so the index is
-- written here instead of being declared with @@unique in schema.prisma.
-- Consequently Prisma does not know about it: `prisma migrate dev` will not
-- recreate it if this migration is ever rolled back by hand, and `db pull` will
-- not report it. Re-add it here if the table is ever rebuilt.
CREATE UNIQUE INDEX "product_images_primary_key" ON "product_images"("product_id") WHERE "is_primary" = true;

-- AddForeignKey
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
