import { Module } from '@nestjs/common';
import { ProductsModule } from '../products/products.module.js';
import { ProductAttributesController } from './product-attributes.controller.js';
import { ProductAttributesService } from './product-attributes.service.js';
import { ProductAttributesRepository } from './repositories/product-attributes.repository.js';

/**
 * Imports `ProductsModule` for `ProductsRepository`. `ProductAttributesService`
 * uses it to confirm the owning product exists without duplicating any SQL for
 * `products` or reaching into another aggregate's table.
 *
 * The edge runs one way — ProductAttributes -> Products — so the module graph
 * stays acyclic. `ProductsModule` does not import this module: attributes are
 * reached through the nested route, not by injecting an attribute service upward.
 *
 * Nothing is exported: no other module needs product-attribute behaviour yet.
 *
 * `PrismaService` arrives without an explicit import because `PrismaModule` is
 * `@Global`.
 */
@Module({
  imports: [ProductsModule],
  controllers: [ProductAttributesController],
  providers: [ProductAttributesService, ProductAttributesRepository],
})
export class ProductAttributesModule {}
