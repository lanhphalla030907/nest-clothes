import { Module } from '@nestjs/common';
import { AddressesModule } from './addresses/addresses.module.js';
import { AdminModule } from './admin/admin.module.js';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AuthModule } from './auth/auth.module.js';
import { CartModule } from './cart/cart.module.js';
import { CheckoutModule } from './checkout/checkout.module.js';
import { CategoriesModule } from './categories/categories.module.js';
import { CodAreasModule } from './cod-areas/cod-areas.module.js';
import { CloudinaryModule } from './cloudinary/cloudinary.module.js';
import { DeliveryModule } from './delivery/delivery.module.js';
import { InventoryModule } from './inventory/inventory.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ProductAttributesModule } from './product-attributes/product-attributes.module.js';
import { ProductImagesModule } from './product-images/product-images.module.js';
import { ProductsModule } from './products/products.module.js';
import { ProductVariantsModule } from './product-variants/product-variants.module.js';
import { ShippingProvidersModule } from './shipping-providers/shipping-providers.module.js';
import { UsersModule } from './users/users.module.js';
import { VariantOptionsModule } from './variant-options/variant-options.module.js';
import { WishlistModule } from './wishlist/wishlist.module.js';
import { OrderModule } from './orders/order.module.js';
import { PaymentsModule } from './payments/payments.module.js';
import { LocationsModule } from './locations/locations.module.js';

@Module({
  imports: [
    /**
     * CloudinaryModule is @Global and comes first so its validated credentials
     * and configured client exist before anything that could depend on them. It
     * throws at construction when the CLOUDINARY_* variables are absent, which is
     * what makes a misconfigured deployment fail at startup.
     */
    CloudinaryModule,
    PrismaModule,
    AuthModule,
    UsersModule,
    /**
     * AdminModule comes after AuthModule and UsersModule because it mounts the
     * role-guarded routes: it needs JwtAuthGuard/RolesGuard from the former's
     * JwtAuthModule and UsersService from the latter. It is a consumer of both, so
     * neither imports it.
     */
    AdminModule,
    CategoriesModule,
    CodAreasModule,
    LocationsModule,
    ProductsModule,
    ProductImagesModule,
    ProductVariantsModule,
    VariantOptionsModule,
    ProductAttributesModule,
    InventoryModule,
    ShippingProvidersModule,
    /**
     * CartModule comes last because it depends on UsersModule,
     * ProductVariantsModule and InventoryModule for their repositories.
     */
    CartModule,
    /**
     * WishlistModule comes after ProductsModule because it depends on
     * UsersModule and ProductsModule for their repositories.
     */
    WishlistModule,
    /**
     * AddressesModule comes after UsersModule because it depends on
     * UsersRepository to confirm the temporary identity is a real user.
     */
    AddressesModule,
    OrderModule,
    DeliveryModule,
    /**
     * CheckoutModule depends on all of the cart, addresses, inventory and orders at
     * once — it is what those four aggregate into.
     */
    CheckoutModule,
    /**
     * PaymentsModule comes after CheckoutModule and OrderModule because it
     * depends on OrderRepository: confirming a verified payment promotes the order
     * from PENDING to CONFIRMED, and that write has to share a transaction with the
     * payment's own PAID update.
     *
     * It is imported last because it is the only consumer of every earlier phase — an
     * order, a priced total, and the inventory that total was computed against. It
     * reaches none of them directly, only OrderRepository, so the dependency edges
     * stay one way.
     */
    PaymentsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
