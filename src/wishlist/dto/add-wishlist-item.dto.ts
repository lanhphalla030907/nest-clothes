import { IsUUID } from 'class-validator';

/**
 * Input contract for `POST /wishlist/items`.
 *
 * `id`, `wishlistId` and `createdAt` are intentionally absent. The global
 * `ValidationPipe` runs with `forbidNonWhitelisted`, so a client attempting to set
 * any of them is rejected with 400 rather than having them silently ignored — the
 * wishlist owner comes from the request identity and the timestamp is owned
 * entirely by the database.
 *
 * There is deliberately no `quantity` either. A wishlist records *that* a product
 * is wanted, never how many of it: "I want two of these" is a cart decision, and a
 * quantity here would turn the wishlist into a second, unreconciled cart.
 *
 * The product is addressed by id rather than by slug so the client never has to
 * know the normalisation rules slugs follow.
 */
export class AddWishlistItemDto {
  @IsUUID()
  productId: string;
}
