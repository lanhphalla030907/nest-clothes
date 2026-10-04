import { WishlistItemResponseDto } from './wishlist-item-response.dto.js';
import type { WishlistWithItems } from '../repositories/wishlist.repository.js';

/**
 * Outbound representation of a wishlist and the products saved on it.
 *
 * Only `id`, `userId` and the timestamps of the wishlist itself are exposed. The
 * owning `user` relation is never included in the query, so no user column — least
 * of all `passwordHash` — can reach the client. Ownership is expressed by the id
 * alone.
 *
 * `itemCount` is derived so a storefront badge does not have to count the items
 * itself. There is deliberately no `subtotal`: a wishlist carries no quantity and
 * makes no promise about price, so summing amounts over it would invent a total
 * the customer never agreed to. It is a list of interests, not a basket.
 */
export class WishlistResponseDto {
  id: string;
  userId: string;
  items: WishlistItemResponseDto[];
  /** Number of saved products. */
  itemCount: number;
  createdAt: Date;
  updatedAt: Date;

  static fromEntity(wishlist: WishlistWithItems): WishlistResponseDto {
    const dto = new WishlistResponseDto();
    const items = wishlist.items.map((item) =>
      WishlistItemResponseDto.fromCatalog(item),
    );

    dto.id = wishlist.id;
    dto.userId = wishlist.userId;
    dto.items = items;
    dto.itemCount = items.length;
    dto.createdAt = wishlist.createdAt;
    dto.updatedAt = wishlist.updatedAt;
    return dto;
  }
}
