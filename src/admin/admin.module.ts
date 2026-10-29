import { Module } from '@nestjs/common';
import { JwtAuthModule } from '../auth/jwt/jwt-auth.module.js';
import { CategoriesModule } from '../categories/categories.module.js';
import { CodAreasModule } from '../cod-areas/cod-areas.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { OrderModule } from '../orders/order.module.js';
import { ProductImagesModule } from '../product-images/product-images.module.js';
import { ProductsModule } from '../products/products.module.js';
import { ProductVariantsModule } from '../product-variants/product-variants.module.js';
import { ShippingProvidersModule } from '../shipping-providers/shipping-providers.module.js';
import { UsersModule } from '../users/users.module.js';
import { LocationsModule } from '../locations/locations.module.js';
import { VariantOptionsModule } from '../variant-options/variant-options.module.js';
import { AdminController } from './admin.controller.js';
import { AdminCategoriesController } from './controllers/admin-categories.controller.js';
import { AdminCodAreasController } from './controllers/admin-cod-areas.controller.js';
import { AdminCodEligibilityController } from './controllers/admin-cod-eligibility.controller.js';
import { AdminInventoryController } from './controllers/admin-inventory.controller.js';
import { AdminOrdersController } from './controllers/admin-orders.controller.js';
import { AdminProductImagesController } from './controllers/admin-product-images.controller.js';
import { AdminProductVariantsController } from './controllers/admin-product-variants.controller.js';
import { AdminProductsController } from './controllers/admin-products.controller.js';
import { AdminShippingProvidersController } from './controllers/admin-shipping-providers.controller.js';
import { AdminVariantOptionsController } from './controllers/admin-variant-options.controller.js';

/**
 * Every route that requires `ADMIN`, and nothing else.
 *
 * ## Why this module exists
 *
 * Role authorisation needs somewhere to live, and the obvious placements are both wrong:
 * putting an `@Roles(ADMIN)` route on `UsersController` would make `UsersModule` import
 * `JwtAuthModule`, which already depends on `UsersModule` — a module cycle. Putting it in
 * `AuthModule` would give the login feature the ability to read arbitrary user rows,
 * which is a wider capability than logging in needs.
 *
 * A module whose entire content is "routes that require `ADMIN`" keeps that capability
 * visible and reviewable: if this module grows a route, the growth is a change to one
 * short file that says what an administrator may do.
 *
 * ## Why it imports the domain services
 *
 * Every controller here is a role-gated shell over the feature it administers. It holds
 * no business rules of its own — the category hierarchy, the catalogue slug and lifecycle
 * rules, the image primary invariant and Cloudinary compensation, the SKU uniqueness and
 * price rules, the option-name uniqueness, the transactional stock invariants, and the
 * global order listing's date/search/pagination semantics are all reached by delegating
 * to `CategoriesService`, `ProductsService`, `ProductImagesService`,
 * `ProductVariantsService`, `VariantOptionsService`, `InventoryService` and `OrderService`.
 *
 * The order routes delegate their listing and detail reads to `OrderService`, and
 * delegate cancellation/shipment to the same service. That keeps the dashboard, the
 * customer's own order reads and the two lifecycle actions on one repository
 * projection and one set of rules, while the controller supplies the one thing an
 * administrative route adds: `ADMIN` authority over data that is not scoped by owner.
 * There is no arbitrary status assignment; the only mutations are the named cancel
 * and ship actions, each with its own guards and inventory movement.
 *
 * That is the reason those modules now export their service as well as their repository.
 * Reusing one implementation is what makes it impossible for an administrative write to
 * disagree with a public one about, say, what a valid slug is or when a category may be
 * deleted — where an admin-specific service would have been a second answer, free to
 * drift. The exports grant no new capability: they are the same methods the public routes
 * call, reachable from a route whose every handler is behind `RolesGuard`.
 *
 * All of these edges point inward — nothing imports `AdminModule` — so no other feature
 * can reach an administrative route by accident, and the domain modules have no reason to
 * know an administrator exists.
 *
 * ## Authorisation is server-side
 *
 * Each controller carries `@UseGuards(JwtAuthGuard, RolesGuard)` and `@Roles(Role.ADMIN)`
 * on the **class**, so the requirement is inherited by every handler including any added
 * later, and `RolesGuard` reads the role from the user row the guard loaded from the
 * database — never from a token claim and never from anything in the request.
 */
@Module({
  imports: [
    JwtAuthModule,
    UsersModule,
    CategoriesModule,
    CodAreasModule,
    ProductsModule,
    ProductImagesModule,
    ProductVariantsModule,
    VariantOptionsModule,
    InventoryModule,
    OrderModule,
    ShippingProvidersModule,
    LocationsModule,
  ],
  controllers: [
    AdminController,
    AdminCategoriesController,
    AdminCodAreasController,
    AdminCodEligibilityController,
    AdminProductsController,
    AdminProductImagesController,
    AdminProductVariantsController,
    AdminVariantOptionsController,
    AdminInventoryController,
    AdminOrdersController,
    AdminShippingProvidersController,
  ],
})
export class AdminModule {}
