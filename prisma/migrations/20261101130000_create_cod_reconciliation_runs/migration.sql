-- CreateTable
CREATE TABLE "cod_reconciliation_runs" (
    "id" UUID NOT NULL,
    "trigger_type" VARCHAR(10) NOT NULL,
    "status" VARCHAR(10) NOT NULL DEFAULT 'running',
    "window_start" TIMESTAMPTZ NOT NULL,
    "window_end" TIMESTAMPTZ NOT NULL,
    "processed_count" INTEGER NOT NULL DEFAULT 0,
    "matched_count" INTEGER NOT NULL DEFAULT 0,
    "discrepancy_count" INTEGER NOT NULL DEFAULT 0,
    "uncollected_count" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cod_reconciliation_runs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "cod_reconciliation_runs_trigger_type_check"
        CHECK ("trigger_type" IN ('cron', 'manual')),
    CONSTRAINT "cod_reconciliation_runs_status_check"
        CHECK ("status" IN ('running', 'completed', 'failed')),
    CONSTRAINT "cod_reconciliation_runs_window_check"
        CHECK ("window_start" < "window_end"),
    CONSTRAINT "cod_reconciliation_runs_processed_count_check"
        CHECK ("processed_count" >= 0),
    CONSTRAINT "cod_reconciliation_runs_matched_count_check"
        CHECK ("matched_count" >= 0),
    CONSTRAINT "cod_reconciliation_runs_discrepancy_count_check"
        CHECK ("discrepancy_count" >= 0),
    CONSTRAINT "cod_reconciliation_runs_uncollected_count_check"
        CHECK ("uncollected_count" >= 0)
);

-- Only failed runs may be retried for the same window and trigger.
CREATE UNIQUE INDEX "cod_reconciliation_runs_window_trigger_active_key"
    ON "cod_reconciliation_runs"("window_start", "window_end", "trigger_type")
    WHERE "status" <> 'failed';

-- Stable newest-first run history, including deterministic ties.
CREATE INDEX "cod_reconciliation_runs_created_at_id_idx"
    ON "cod_reconciliation_runs"("created_at" DESC, "id" DESC);
