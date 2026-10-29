-- The administrative order listing is global and ordered newest first:
--   ORDER BY created_at DESC, id DESC
-- The existing `orders_user_id_created_at_id_idx` cannot serve it because `user_id`
-- has no equality predicate. Without this index PostgreSQL has to sort the whole
-- table for every page.
CREATE INDEX "orders_created_at_id_idx"
  ON "orders" ("created_at" DESC, "id" DESC);

-- The same listing narrowed by status:
--   WHERE status = $1 ORDER BY created_at DESC, id DESC
-- With `status` as the equality prefix followed by the exact ordering, the page is
-- read directly from the index. This also serves a status-only filter, so no
-- separate `(status)` index is required.
CREATE INDEX "orders_status_created_at_id_idx"
  ON "orders" ("status", "created_at" DESC, "id" DESC);
