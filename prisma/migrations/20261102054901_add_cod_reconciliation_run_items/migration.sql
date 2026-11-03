-- CreateTable
CREATE TABLE "cod_reconciliation_run_items" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "order_number" VARCHAR(30),
    "currency" CHAR(3) NOT NULL,
    "expected_amount" DECIMAL(12,2) NOT NULL,
    "collected_amount" DECIMAL(12,2),
    "collection_currency" CHAR(3),
    "collection_id" UUID,
    "collected_at" TIMESTAMPTZ,
    "collected_by_id" UUID,
    "collected_by_first_name" VARCHAR(100),
    "collected_by_last_name" VARCHAR(100),
    "collected_by_email" VARCHAR(255),
    "delivery_staff_id" UUID,
    "delivery_staff_first_name" VARCHAR(100),
    "delivery_staff_last_name" VARCHAR(100),
    "delivery_staff_email" VARCHAR(255),
    "delivered_at" TIMESTAMPTZ,
    "assignment_id" UUID,
    "discrepancy" BOOLEAN NOT NULL DEFAULT false,
    "discrepancy_type" VARCHAR(20),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cod_reconciliation_run_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cod_reconciliation_run_items_run_id_idx" ON "cod_reconciliation_run_items"("run_id");

-- CreateIndex
CREATE INDEX "cod_reconciliation_run_items_run_id_discrepancy_idx" ON "cod_reconciliation_run_items"("run_id", "discrepancy");

-- CreateIndex
CREATE INDEX "cod_reconciliation_run_items_order_id_idx" ON "cod_reconciliation_run_items"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "cod_reconciliation_run_items_run_id_order_id_key" ON "cod_reconciliation_run_items"("run_id", "order_id");

-- RenameForeignKey
ALTER TABLE "checkout_quotes" RENAME CONSTRAINT "checkout_quotes_order_fk" TO "checkout_quotes_order_id_fkey";

-- RenameForeignKey
ALTER TABLE "checkout_quotes" RENAME CONSTRAINT "checkout_quotes_user_fk" TO "checkout_quotes_user_id_fkey";

-- RenameForeignKey
ALTER TABLE "orders" RENAME CONSTRAINT "orders_cod_area_fk" TO "orders_cod_area_id_fkey";

-- RenameForeignKey
ALTER TABLE "orders" RENAME CONSTRAINT "orders_shipping_provider_fk" TO "orders_shipping_provider_id_fkey";

-- AddForeignKey
ALTER TABLE "cod_reconciliation_run_items" ADD CONSTRAINT "cod_reconciliation_run_items_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "cod_reconciliation_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "checkout_quotes_user_expires_at_idx" RENAME TO "checkout_quotes_user_id_expires_at_idx";

-- RenameIndex
ALTER INDEX "checkout_quotes_user_idempotency_key_key" RENAME TO "checkout_quotes_user_id_idempotency_key_key";
