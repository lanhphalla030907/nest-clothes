import { Module } from '@nestjs/common';
import { ProductsModule } from '../products/products.module.js';
import { ProductVariantsController } from './product-variants.controller.js';
import { ProductVariantsService } from './product-variants.service.js';
import { ProductVariantsRepository } from './repositories/product-variants.repository.js';

/**
 * Imports `ProductsModule` for `ProductsRepository`, which
 * `ProductVariantsService` uses to confirm the owning product exists without
 * duplicating any SQL for `products` or reaching into another aggregate's table.
 *
 * The edge runs one way — ProductVariants -> Products — so the module graph stays
 * acyclic. Note that `ProductsModule` does **not** import this one: variants are
 * reached through the nested route, not by injecting a variant service into the
 * product feature.
 *
 * Exports `ProductVariantsRepository` — and only the repository — so that
 * `VariantOptionsService` can confirm a variant exists and belongs to the product
 * in the path through the repository boundary instead of querying
 * `product_variants` from its own repository. This mirrors `ProductsModule`,
 * which exports `ProductsRepository` for `ProductVariantsService`.
 *
 * `ProductVariantsService` is deliberately *not* exported: nothing outside this
 * module needs variant business rules.
 *
 * Nothing here imports `VariantOptionsModule`; the edge runs VariantOptions ->
 * ProductVariants, never the reverse, so the graph stays acyclic.
 *
 * `PrismaService` arrives without an explicit import because `PrismaModule` is
 * `@Global`.
 */
@Module({
  imports: [ProductsModule],
  controllers: [ProductVariantsController],
  providers: [ProductVariantsService, ProductVariantsRepository],
  exports: [ProductVariantsRepository],
})
export class ProductVariantsModule {}
