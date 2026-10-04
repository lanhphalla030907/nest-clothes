import { Prisma } from '../../generated/prisma/client.js';
import { CartItemResponseDto } from './cart-item-response.dto.js';
import type { CartWithItems } from '../repositories/cart.repository.js';

/**
 * Outbound representation of a cart and its lines.
 *
 * Only `id`, `userId` and the timestamps of the cart itself are exposed. The
 * owning `user` relation is never included in the query, so no user column —
 * least of all `passwordHash` — can reach the client. Ownership is expressed by
 * the id alone.
 *
 * `itemCount` and `subtotal` are derived totals so a storefront header does not
 * have to reduce the lines itself. `subtotal` is summed with `Decimal` and
 * serialised as a fixed two-decimal string, matching every other amount in this
 * project. It is a *cart* subtotal only: no shipping, tax or discount exists yet,
 * so calling it `total` would promise arithmetic the backend has not
 * implemented.
 *
 * The stock caveat stated on `CartItemResponseDto` applies here too: a cart does
 * not reserve inventory, so `subtotal` describes intent rather than a confirmed,
 * purchasable basket.
 */
export class CartResponseDto {
  id: string;
  userId: string;
  items: CartItemResponseDto[];
  /** Sum of every line's `quantity`. */
  itemCount: number;
  /** Sum of every line's `lineTotal`, as a fixed two-decimal string. */
  subtotal: string;
  createdAt: Date;
  updatedAt: Date;

  static fromEntity(cart: CartWithItems): CartResponseDto {
    const dto = new CartResponseDto();
    const items = cart.items.map((item) =>
      CartItemResponseDto.fromCatalog(item),
    );

    dto.id = cart.id;
    dto.userId = cart.userId;
    dto.items = items;
    dto.itemCount = items.reduce((total, item) => total + item.quantity, 0);
    dto.subtotal = items
      .reduce(
        (total, item) => total.plus(item.lineTotal),
        new Prisma.Decimal(0),
      )
      .toFixed(2);
    dto.createdAt = cart.createdAt;
    dto.updatedAt = cart.updatedAt;
    return dto;
  }
}
