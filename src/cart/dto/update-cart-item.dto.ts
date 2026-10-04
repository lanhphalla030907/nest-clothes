import { IsInt, Min } from 'class-validator';

/**
 * Input contract for `PATCH /cart/items/:itemId`.
 *
 * Only the quantity is editable, and it is **absolute**, not a delta: a client
 * that wants three units sends `3`, never "two more". That keeps the row the
 * whole truth about the line and makes a retried request idempotent.
 *
 * `itemId` is a path parameter, so it cannot be smuggled in here to move a line
 * between carts — and because the global pipe runs `forbidNonWhitelisted`,
 * `id`, `cartId`, `variantId`, `createdAt` and `updatedAt` are rejected with 400
 * rather than silently ignored.
 *
 * `@Min(1)` rejects zero: a line with no units is expressed by deleting it, so a
 * zero would otherwise be a second spelling of `DELETE` with different
 * bookkeeping. The database `CHECK (quantity > 0)` enforces the same rule.
 */
export class UpdateCartItemDto {
  @IsInt()
  @Min(1)
  quantity: number;
}
