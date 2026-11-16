-- CreateEnum
CREATE TYPE "PushDeliveryStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "push_subscriptions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "endpoint" VARCHAR(2048) NOT NULL,
    "p256dh" VARCHAR(500) NOT NULL,
    "auth" VARCHAR(255) NOT NULL,
    "user_agent" VARCHAR(1000),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_seen_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_delivery_jobs" (
    "id" UUID NOT NULL,
    "notification_id" UUID,
    "user_id" UUID NOT NULL,
    "push_subscription_id" UUID NOT NULL,
    "status" "PushDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "next_attempt_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMPTZ,
    "locked_by" VARCHAR(100),
    "lease_expires_at" TIMESTAMPTZ,
    "last_error_code" VARCHAR(100),
    "last_error_message" VARCHAR(2000),
    "payload" JSONB,
    "sent_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "push_delivery_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");

-- CreateIndex
CREATE INDEX "push_subscriptions_user_id_is_active_idx" ON "push_subscriptions"("user_id", "is_active");

-- CreateIndex
CREATE INDEX "push_delivery_jobs_status_next_attempt_at_idx" ON "push_delivery_jobs"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "push_delivery_jobs_push_subscription_id_status_idx" ON "push_delivery_jobs"("push_subscription_id", "status");

-- CreateIndex
CREATE INDEX "push_delivery_jobs_user_id_status_idx" ON "push_delivery_jobs"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "push_delivery_jobs_notification_id_push_subscription_id_key" ON "push_delivery_jobs"("notification_id", "push_subscription_id");

-- AddForeignKey
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_delivery_jobs" ADD CONSTRAINT "push_delivery_jobs_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_delivery_jobs" ADD CONSTRAINT "push_delivery_jobs_push_subscription_id_fkey" FOREIGN KEY ("push_subscription_id") REFERENCES "push_subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
