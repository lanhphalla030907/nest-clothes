import { IsInt, IsOptional, Min } from 'class-validator';

/**
 * Input contract for
 * `PATCH /products/:productId/variants/:variantId/inventory`.
 *
 * Only the two stock counters are editable. `id`, `variantId`, `createdAt` and
 * `updatedAt` are absent, and because the global pipe runs
 * `forbidNonWhitelisted` a client that sends them gets a 400 instead of a
 * silently ignored field. Moving inventory to another variant is not an edit; the
 * unique owner is fixed at creation.
 *
 * Every field is optional, but the validation rules are deliberately repeated
 * rather than inherited: an update is validated exactly as strictly as a create,
 * and only the requiredness is relaxed. When only one counter is sent the other
 * is read from the current row inside the service's transaction, and the merged
 * pair is checked against `reservedQuantity <= quantity` before the write.
 */
export class UpdateInventoryDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  quantity?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  reservedQuantity?: number;
}
