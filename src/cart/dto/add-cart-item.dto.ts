import { IsInt, IsUUID, Min } from 'class-validator';

/**
 * Input contract for `POST /cart/items`.
 *
 * `id`, `cartId`, `createdAt` and `updatedAt` are intentionally absent. The
 * global `ValidationPipe` runs with `forbidNonWhitelisted`, so a client
 * attempting to set any of them is rejected with 400 rather than having them
 * silently ignored — the cart owner comes from the request identity and the
 * timestamps are owned entirely by the service and the database.
 *
 * `quantity` is required and must be a positive integer: `@IsInt` rejects
 * fractions and numeric strings, and `@Min(1)` rejects zero and negatives.
 * Whole units are required because stock is counted in whole units — a
 * fractional quantity is a modelling error, not a rounding choice. Note that
 * this is an *increment* for a line that already exists; see the service for
 * why a zero is not accepted as "leave it as it is".
 *
 * The variant is addressed by id rather than by SKU so the client never has to
 * know the normalisation rules SKU identifiers follow.
 */
export class AddCartItemDto {
  @IsUUID()
  variantId: string;

  @IsInt()
  @Min(1)
  quantity: number;
}
