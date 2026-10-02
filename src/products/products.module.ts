import { Module } from '@nestjs/common';
import { CategoriesModule } from '../categories/categories.module.js';
import { ProductsController } from './products.controller.js';
import { ProductsService } from './products.service.js';
import { ProductsRepository } from './repositories/products.repository.js';

/**
 * Imports `CategoriesModule` for `CategoriesRepository`, which `ProductsService`
 * uses to validate a product's category without duplicating any SQL for
 * `categories`. The edge runs one way, so the module graph stays acyclic.
 *
 * Exports `ProductsRepository` — and only the repository — so that
 * `ProductImagesService` can confirm a product exists through the repository
 * boundary instead of querying `products` from its own repository. This mirrors
 * `CategoriesModule`, which exports `CategoriesRepository` for `ProductsService`.
 *
 * `ProductsService` is deliberately *not* exported: nothing outside this module
 * needs product business rules, and lifecycle transitions will need an
 * authorised consumer that does not exist yet.
 *
 * `PrismaService` arrives without an explicit import because `PrismaModule` is
 * `@Global`.
 *
 * The graph stays acyclic: `ProductImagesModule` imports this module, never the
 * other way round.
 */
@Module({
  imports: [CategoriesModule],
  controllers: [ProductsController],
  providers: [ProductsService, ProductsRepository],
  exports: [ProductsRepository],
})
export class ProductsModule {}