import { IsInt, IsOptional, Min } from 'class-validator';

/**
 * Input contract for `POST /products/:productId/variants/:variantId/inventory`.
 *
 * `id`, `variantId`, `createdAt` and `updatedAt` are intentionally absent. The
 * global `ValidationPipe` runs with `forbidNonWhitelisted`, so a client
 * attempting to set any of them is rejected with 400 rather than having them
 * silently ignored — ownership and the timestamps are owned entirely by the
 * service and the database.
 *
 * Both counters are optional and default to `0` in the service, so a variant can
 * be given an empty inventory row without the client sending a body at all.
 *
 * The values are integers only: `@IsInt` rejects fractions and strings, and
 * `@Min(0)` rejects negatives. Integers are required because stock is counted in
 * whole units — a fractional quantity is a modelling error, not a rounding
 * choice. `reservedQuantity <= quantity` is a cross-field rule and is enforced by
 * the service and by the table's `CHECK` constraint.
 */
export class CreateInventoryDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  quantity?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  reservedQuantity?: number;
}
