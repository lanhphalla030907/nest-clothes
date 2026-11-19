-- AddColumn
ALTER TABLE "refresh_sessions"
ADD COLUMN "replaced_by_token_hash" VARCHAR(64);

-- CreateIndex
CREATE UNIQUE INDEX "refresh_sessions_replaced_by_token_hash_key"
ON "refresh_sessions"("replaced_by_token_hash");
