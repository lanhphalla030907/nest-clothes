-- AddEnumValues
--
-- Additive only: every statement appends a value to the existing "NotificationType"
-- enum. No row is read, written or deleted, so existing notifications keep their
-- current type. `IF NOT EXISTS` makes the migration idempotent and safe to re-run
-- against a database where a value was already added by hand.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ORDER_CONFIRMED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ORDER_OUT_FOR_DELIVERY';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ADMIN_PAYMENT_SUCCESS';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ADMIN_ORDER_CANCELLED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ADMIN_LOW_STOCK';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ADMIN_OUT_OF_STOCK';
