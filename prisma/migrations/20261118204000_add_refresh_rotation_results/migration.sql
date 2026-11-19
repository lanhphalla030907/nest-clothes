-- CreateEnum
CREATE TYPE "RefreshRotationStatus" AS ENUM ('PENDING', 'SUCCEEDED');

-- CreateTable
CREATE TABLE "refresh_rotation_results" (
    "id" UUID NOT NULL,
    "operation_key_hash" VARCHAR(64) NOT NULL,
    "old_refresh_session_id" UUID NOT NULL,
    "old_token_hash" VARCHAR(64) NOT NULL,
    "family_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "RefreshRotationStatus" NOT NULL,
    "encrypted_payload" TEXT,
    "nonce" VARCHAR(16),
    "authentication_tag" VARCHAR(24),
    "payload_key_version" INTEGER,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "completed_at" TIMESTAMPTZ,

    CONSTRAINT "refresh_rotation_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "refresh_rotation_results_operation_key_hash_key"
ON "refresh_rotation_results"("operation_key_hash");

-- CreateIndex
CREATE INDEX "refresh_rotation_results_old_refresh_session_id_status_idx"
ON "refresh_rotation_results"("old_refresh_session_id", "status");

-- CreateIndex
CREATE INDEX "refresh_rotation_results_old_token_hash_status_idx"
ON "refresh_rotation_results"("old_token_hash", "status");

-- CreateIndex
CREATE INDEX "refresh_rotation_results_family_id_status_idx"
ON "refresh_rotation_results"("family_id", "status");

-- CreateIndex
CREATE INDEX "refresh_rotation_results_user_id_status_idx"
ON "refresh_rotation_results"("user_id", "status");

-- CreateIndex
CREATE INDEX "refresh_rotation_results_expires_at_idx"
ON "refresh_rotation_results"("expires_at");

-- Valid states
ALTER TABLE "refresh_rotation_results"
ADD CONSTRAINT "refresh_rotation_results_state_check"
CHECK (
  ("status" = 'PENDING'
   AND "encrypted_payload" IS NULL
   AND "nonce" IS NULL
   AND "authentication_tag" IS NULL
   AND "payload_key_version" IS NULL
   AND "completed_at" IS NULL)
  OR
  ("status" = 'SUCCEEDED'
   AND "encrypted_payload" IS NOT NULL
   AND "nonce" IS NOT NULL
   AND "authentication_tag" IS NOT NULL
   AND "payload_key_version" IS NOT NULL
   AND "completed_at" IS NOT NULL)
);

-- AddForeignKey
ALTER TABLE "refresh_rotation_results"
ADD CONSTRAINT "refresh_rotation_results_old_refresh_session_id_fkey"
FOREIGN KEY ("old_refresh_session_id") REFERENCES "refresh_sessions"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_rotation_results"
ADD CONSTRAINT "refresh_rotation_results_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
