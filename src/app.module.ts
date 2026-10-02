import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AuthModule } from './auth/auth.module.js';
import { CategoriesModule } from './categories/categories.module.js';
import { CloudinaryModule } from './cloudinary/cloudinary.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ProductImagesModule } from './product-images/product-images.module.js';
import { ProductsModule } from './products/products.module.js';
import { ProductVariantsModule } from './product-variants/product-variants.module.js';
import { UsersModule } from './users/users.module.js';
import { VariantOptionsModule } from './variant-options/variant-options.module.js';

@Module({
  imports: [
    /**
     * `CloudinaryModule` is `@Global` and comes first so its validated credentials
     * and configured client exist before anything that could depend on them. It
     * throws at construction when the `CLOUDINARY_*` variables are absent, which is
     * what makes a misconfigured deployment fail at startup.
     */
    CloudinaryModule,
    PrismaModule,
    AuthModule,
    UsersModule,
    CategoriesModule,
    ProductsModule,
    ProductImagesModule,
    ProductVariantsModule,
    VariantOptionsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
