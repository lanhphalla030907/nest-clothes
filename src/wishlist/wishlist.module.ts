import { Module } from '@nestjs/common';
import { JwtAuthModule } from '../auth/jwt/jwt-auth.module.js';
import { ProductsModule } from '../products/products.module.js';
import { UsersModule } from '../users/users.module.js';
import { WishlistController } from './wishlist.controller.js';
import { WishlistService } from './wishlist.service.js';
import { WishlistRepository } from './repositories/wishlist.repository.js';

/**
 * Owns the wishlist aggregate: `wishlists` and `wishlist_items`, plus the rules
 * about what may be saved on one.
 *
 * Imports `JwtAuthModule`, for the guard the controller is decorated with, plus two
 * sibling features for their repositories:
 *
 * - `UsersRepository` — to confirm the caller behind the access token is a real user
 *   before writing a wishlist on their behalf.
 * - `ProductsRepository` — to confirm a product exists before saving it, without
 *   this module issuing any SQL against `products`.
 *
 * Each of those modules already exports its repository for exactly this purpose,
 * so no module reaches into another's tables and the edges run one way:
 * Wishlist -> {Users, Products} -> Categories. Nothing imports `WishlistModule` yet;
 * a future phase that needs to merge a saved product into a cart will.
 *
 * A wishlist is a *separate* aggregate from the cart, not a second cart: it holds
 * no quantity, claims no stock and carries no price promise, so nothing in this
 * module imports `CartModule` and no cart behaviour is reachable from here.
 *
 * Nothing is exported: no other module needs wishlist behaviour at this phase.
 *
 * `PrismaService` arrives without an explicit import because `PrismaModule` is
 * `@Global`.
 */
@Module({
  imports: [JwtAuthModule, UsersModule, ProductsModule],
  controllers: [WishlistController],
  providers: [WishlistService, WishlistRepository],
})
export class WishlistModule {}
