-- Add endedAt to delivery_assignments for better history tracking
ALTER TABLE "delivery_assignments" ADD COLUMN "ended_at" TIMESTAMPTZ;

-- Create partial unique index to enforce at most one active assignment per order
-- An assignment is active if ended_at IS NULL and status is not terminal
CREATE UNIQUE INDEX "delivery_assignments_one_active_per_order" 
ON "delivery_assignments" ("order_id") 
WHERE "ended_at" IS NULL AND "status" NOT IN ('DELIVERED', 'RETURNED');

-- Create index for efficient queries
CREATE INDEX "delivery_assignments_order_id_ended_at_idx" ON "delivery_assignments"("order_id", "ended_at");
