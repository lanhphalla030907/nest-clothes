-- CreateEnum
-- The delivery lifecycle is separate from `orders.status`: a confirmed, paid order
-- still has to be assigned, picked up, delivered, or returned, and a failed attempt
-- must not rewrite the order's own state.
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING_ASSIGNMENT', 'ASSIGNED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED_DELIVERY', 'RETURNED');

-- AlterEnum
-- Existing CUSTOMER and ADMIN rows are untouched. Delivery roles are additive, so no
-- data migration is needed.
ALTER TYPE "Role" ADD VALUE 'DELIVERY_MANAGER';
ALTER TYPE "Role" ADD VALUE 'DELIVERY_STAFF';

-- CreateTable
-- One row per assignment, not one row per order. Reassignment inserts a new row and
-- leaves the previous one intact; there is deliberately no unique constraint on
-- `order_id` (or on `order_id, delivery_staff_id`) because assignment history is the
-- point of the table. The current assignment is the newest `assigned_at` row.
CREATE TABLE "delivery_assignments" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "delivery_staff_id" UUID NOT NULL,
    "assigned_by_id" UUID NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'ASSIGNED',
    "assigned_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ,
    "delivered_at" TIMESTAMPTZ,
    "notes" TEXT,
    "delivery_proof" JSONB,

    CONSTRAINT "delivery_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- A COD collection is evidence that cash was actually received, not a payment
-- attempt. `order_id` and `payment_id` are both unique: the first makes a second
-- collection for one order impossible, the second stops two collections claiming the
-- same payment. PostgreSQL allows multiple NULLs in a unique column, so a COD order
-- with no `Payment` row is still valid.
CREATE TABLE "cod_collections" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "payment_id" UUID,
    "collected_by_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "collected_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "receipt_proof" JSONB,

    CONSTRAINT "cod_collections_pkey" PRIMARY KEY ("id"),

    -- Same rule as `payments_amount_positive`: a collection of zero is not a
    -- collection, and a negative one would mean money left the courier.
    CONSTRAINT "cod_collections_amount_positive" CHECK ("amount" > 0),
    -- ISO 4217 alphabetic code, matching the shape checks on orders and payments.
    CONSTRAINT "cod_collections_currency_iso_4217_shape" CHECK ("currency" ~ '^[A-Z]{3}$')
);

-- CreateIndex
-- Serves an order's assignment history, newest first. `id` is the deterministic
-- tiebreak for assignments created in the same millisecond.
CREATE INDEX "delivery_assignments_order_id_assigned_at_id_idx" ON "delivery_assignments"("order_id", "assigned_at" DESC, "id" DESC);

-- CreateIndex
-- Serves a courier's queue, optionally filtered by status, in newest-first order.
CREATE INDEX "delivery_assignments_delivery_staff_id_status_assigned_at_i_idx" ON "delivery_assignments"("delivery_staff_id", "status", "assigned_at" DESC, "id" DESC);

-- CreateIndex
-- Reverse lookup for assignments a manager made, and the FK check.
CREATE INDEX "delivery_assignments_assigned_by_id_idx" ON "delivery_assignments"("assigned_by_id");

-- CreateIndex
-- Duplicate-collection guard for the order side. Also serves the order FK check.
CREATE UNIQUE INDEX "cod_collections_order_id_key" ON "cod_collections"("order_id");

-- CreateIndex
-- Duplicate-collection guard for the payment side. NULLs are not compared, so
-- unlinked collections remain allowed.
CREATE UNIQUE INDEX "cod_collections_payment_id_key" ON "cod_collections"("payment_id");

-- CreateIndex
-- A collector's recent collections and the collector FK check.
CREATE INDEX "cod_collections_collected_by_id_collected_at_idx" ON "cod_collections"("collected_by_id", "collected_at" DESC);

-- AddForeignKey
-- RESTRICT: an assignment is a historical record of who carried a parcel.
ALTER TABLE "delivery_assignments" ADD CONSTRAINT "delivery_assignments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- RESTRICT: deleting a courier must not erase the deliveries they handled.
ALTER TABLE "delivery_assignments" ADD CONSTRAINT "delivery_assignments_delivery_staff_id_fkey" FOREIGN KEY ("delivery_staff_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- RESTRICT: the assigning manager is part of the assignment's history.
ALTER TABLE "delivery_assignments" ADD CONSTRAINT "delivery_assignments_assigned_by_id_fkey" FOREIGN KEY ("assigned_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- RESTRICT: a COD collection is financial evidence and must outlive deletion attempts.
ALTER TABLE "cod_collections" ADD CONSTRAINT "cod_collections_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- RESTRICT: an optional link to the payment attempt must not be silently cleared.
ALTER TABLE "cod_collections" ADD CONSTRAINT "cod_collections_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- RESTRICT: the collector is part of the collection's audit trail.
ALTER TABLE "cod_collections" ADD CONSTRAINT "cod_collections_collected_by_id_fkey" FOREIGN KEY ("collected_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
