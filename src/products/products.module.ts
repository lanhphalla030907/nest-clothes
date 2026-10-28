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
 * Exports `ProductsRepository` — and the repository is what the other product
 * sub-features reach for — so that `ProductImagesService` can confirm a product
 * exists through the repository boundary instead of querying `products` from
 * its own repository. This mirrors `CategoriesModule`, which exports
 * `CategoriesRepository` for `ProductsService`.
 *
 * Also exports `ProductsService`, for `AdminProductsController`. That controller
 * needs the catalogue rules *and* the lifecycle, and both live in this one class:
 * delegating means slug normalisation, the category-must-be-active rule and the
 * duplicate-slug 409 are one implementation rather than an admin copy that can
 * disagree with the public one. The service grants no capability of its own — the
 * lifecycle is only reachable through the `lifecycle` argument, which only an
 * admin DTO can populate and only an admin route passes.
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
  exports: [ProductsRepository, ProductsService],
})
export class ProductsModule {}