-- CreateTable
CREATE TABLE "refresh_operation_tombstones" (
    "id" UUID NOT NULL,
    "operation_key_hash" VARCHAR(64) NOT NULL,
    "old_refresh_session_id" UUID NOT NULL,
    "old_token_hash" VARCHAR(64) NOT NULL,
    "replacement_token_hash" VARCHAR(64),
    "family_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "family_expires_at" TIMESTAMPTZ NOT NULL,
    "completed_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_operation_tombstones_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "refresh_operation_tombstones_operation_key_hash_key"
ON "refresh_operation_tombstones"("operation_key_hash");

-- CreateIndex
CREATE INDEX "refresh_operation_tombstones_old_refresh_session_id_idx"
ON "refresh_operation_tombstones"("old_refresh_session_id");

-- CreateIndex
CREATE INDEX "refresh_operation_tombstones_old_token_hash_idx"
ON "refresh_operation_tombstones"("old_token_hash");

-- CreateIndex
CREATE INDEX "refresh_operation_tombstones_family_id_family_expires_at_idx"
ON "refresh_operation_tombstones"("family_id", "family_expires_at");

-- CreateIndex
CREATE INDEX "refresh_operation_tombstones_family_expires_at_idx"
ON "refresh_operation_tombstones"("family_expires_at");

-- AddForeignKey
ALTER TABLE "refresh_operation_tombstones"
ADD CONSTRAINT "refresh_operation_tombstones_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
