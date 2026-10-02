import { Module } from '@nestjs/common';
import { ProductVariantsModule } from '../product-variants/product-variants.module.js';
import { ProductsModule } from '../products/products.module.js';
import { VariantOptionsController } from './variant-options.controller.js';
import { VariantOptionsService } from './variant-options.service.js';
import { VariantOptionsRepository } from './repositories/variant-options.repository.js';

/**
 * Imports `ProductsModule` for `ProductsRepository` and `ProductVariantsModule`
 * for `ProductVariantsRepository`. `VariantOptionsService` uses them to confirm
 * the owning product exists and that the variant belongs to it, without
 * duplicating any SQL for `products` or `product_variants` or reaching into
 * another aggregate's table.
 *
 * The edges run one way — VariantOptions -> ProductVariants -> Products — so the
 * module graph stays acyclic. Neither parent imports this module: options are
 * reached through the nested route, not by injecting an option service upward.
 *
 * Nothing is exported: no other module needs variant-option behaviour yet.
 *
 * `PrismaService` arrives without an explicit import because `PrismaModule` is
 * `@Global`.
 */
@Module({
  imports: [ProductsModule, ProductVariantsModule],
  controllers: [VariantOptionsController],
  providers: [VariantOptionsService, VariantOptionsRepository],
})
export class VariantOptionsModule {}
