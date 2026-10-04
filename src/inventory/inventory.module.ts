import { Module } from '@nestjs/common';
import { ProductVariantsModule } from '../product-variants/product-variants.module.js';
import { ProductsModule } from '../products/products.module.js';
import { InventoryController } from './inventory.controller.js';
import { InventoryService } from './inventory.service.js';
import { InventoryRepository } from './repositories/inventory.repository.js';

/**
 * Imports `ProductsModule` for `ProductsRepository` and `ProductVariantsModule`
 * for `ProductVariantsRepository`. `InventoryService` uses them to confirm the
 * owning product exists and that the variant belongs to it, without duplicating
 * any SQL for `products` or `product_variants` or reaching into another
 * aggregate's table.
 *
 * The edges run one way — Inventory -> ProductVariants -> Products — so the
 * module graph stays acyclic. Neither parent imports this module: inventory is
 * reached through the nested route, not by injecting an inventory service upward.
 *
 * Exports `InventoryRepository` — and only the repository — so `CartModule` can
 * read the stock counters a cart write must be validated against without
 * duplicating any SQL for `inventory`. `InventoryService` itself is
 * deliberately *not* exported: stock business rules (counter invariants,
 * duplicate detection) belong to the inventory feature, and no other module has
 * a reason to run them.
 *
 * Note that the repository carries no reservation methods yet: reading stock is
 * enough for a cart, which claims nothing. Whoever adds checkout will need a
 * guarded `reserve` on this repository, guarded in SQL rather than by a
 * read-then-write, exactly as `CartRepository.incrementItemQuantityWithinAvailable`
 * guards a cart line.
 *
 * `PrismaService` arrives without an explicit import because `PrismaModule` is
 * `@Global`.
 */
@Module({
  imports: [ProductsModule, ProductVariantsModule],
  controllers: [InventoryController],
  providers: [InventoryService, InventoryRepository],
  exports: [InventoryRepository],
})
export class InventoryModule {}
