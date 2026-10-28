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
 * Exports `InventoryRepository` — so `CartModule` can read the stock counters a
 * cart write must be validated against without duplicating any SQL for
 * `inventory`.
 *
 * Also exports `InventoryService`, for `AdminInventoryController`. The admin
 * routes move stock, and the rules that govern moving it — both counters
 * non-negative, `reservedQuantity <= quantity`, the read-merge-write performed
 * *inside a transaction* so a concurrent checkout reservation cannot be clobbered —
 * are only correct in one place. An admin service of its own would be a second
 * place for them to be wrong, and a read-modify-write outside the transaction
 * would reintroduce exactly the race the repository's `reserve` exists to close.
 * So the admin route delegates, and the counter invariants are enforced by the
 * same code whether the caller is a customer checking out or an administrator
 * correcting a stock count.
 *
 * `PrismaService` arrives without an explicit import because `PrismaModule` is
 * `@Global`.
 */
@Module({
  imports: [ProductsModule, ProductVariantsModule],
  controllers: [InventoryController],
  providers: [InventoryService, InventoryRepository],
  exports: [InventoryRepository, InventoryService],
})
export class InventoryModule {}
