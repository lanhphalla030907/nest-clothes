-- CreateTable
CREATE TABLE "next_drops" (
    "id" UUID NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "launch_at" TIMESTAMPTZ NOT NULL,
    "collection_id" UUID,
    "promotion_id" UUID,
    "button_text" VARCHAR(120),
    "button_url" VARCHAR(2048) NOT NULL,
    "is_published" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "next_drops_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "next_drops_is_published_idx" ON "next_drops"("is_published");

-- Only one drop may be published at a time. Database-level backstop for the
-- service-level rule; the service unpublishes any current drop before
-- publishing another, so this index never blocks a well-ordered publish.
CREATE UNIQUE INDEX "next_drops_one_published_idx" ON "next_drops"("is_published") WHERE "is_published" = true;

-- AddForeignKey
ALTER TABLE "next_drops" ADD CONSTRAINT "next_drops_collection_id_fkey" FOREIGN KEY ("collection_id") REFERENCES "collections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "next_drops" ADD CONSTRAINT "next_drops_promotion_id_fkey" FOREIGN KEY ("promotion_id") REFERENCES "promotions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
