-- Additive snapshot-persistence columns for COD reconciliation.
--
-- `snapshots_written` distinguishes runs that persisted their immutable item
-- snapshots from legacy runs that completed before snapshot persistence existed.
-- The item columns copy the order's status and payment method at execution time.

-- AlterTable
ALTER TABLE "cod_reconciliation_runs"
ADD COLUMN "snapshots_written" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "cod_reconciliation_run_items"
ADD COLUMN "order_status" VARCHAR(30),
ADD COLUMN "payment_method" VARCHAR(30);
