import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module.js';
import { ProductVariantsModule } from '../product-variants/product-variants.module.js';
import { UsersModule } from '../users/users.module.js';
import { CartController } from './cart.controller.js';
import { CartService } from './cart.service.js';
import { CartRepository } from './repositories/cart.repository.js';

/**
 * Owns the cart aggregate: `carts` and `cart_items`, plus the rules about what
 * may go in one.
 *
 * Imports three sibling features for their repositories, and only their
 * repositories:
 *
 * - `UsersRepository` — to confirm the identity behind the temporary `X-User-Id`
 *   header is a real user before writing a cart on their behalf.
 * - `ProductVariantsRepository` — to confirm a requested variant exists and is
 *   active, without this module issuing any SQL against `product_variants`.
 * - `InventoryRepository` — to read the stock counters a cart write must be
 *   validated against, transaction-aware so the read joins the same transaction
 *   as the write.
 *
 * Each of those modules already exports its repository for exactly this purpose,
 * so no module reaches into another's tables and the edges run one way:
 * Cart -> {Users, ProductVariants, Inventory} -> Products. Nothing imports
 * `CartModule` yet; orders will, once they need the cart's lines.
 *
 * `CartRepository` — not `CartService` — is what checkout consumes. Checkout has to
 * read the cart and empty it *inside the transaction that writes the order*, so it
 * needs the query surface rather than the behaviour: a cart service method that
 * opened its own transaction would break that single boundary. Everything the cart
 * *decides* (stock ceilings, duplicate lines, the `INSUFFICIENT_STOCK_MESSAGE` 409)
 * stays here and is not re-implemented by checkout.
 *
 * `PrismaService` arrives without an explicit import because `PrismaModule` is
 * `@Global`.
 */
@Module({
  imports: [UsersModule, ProductVariantsModule, InventoryModule],
  controllers: [CartController],
  providers: [CartService, CartRepository],
  exports: [CartRepository],
})
export class CartModule {}
