-- CreateTable
CREATE TABLE "posters" (
    "id" UUID NOT NULL,
    "title" VARCHAR(255),
    "image_url" VARCHAR(2048) NOT NULL,
    "public_id" VARCHAR(255) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "posters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "posters_is_active_display_order_idx" ON "posters"("is_active", "display_order");
