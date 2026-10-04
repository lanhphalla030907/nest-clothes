import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module.js';
import { OrderNumberGenerator } from './order-number.generator.js';
import { OrderController } from './order.controller.js';
import { OrderService } from './order.service.js';
import { OrderRepository } from './repositories/order.repository.js';

/**
 * Owns the orders aggregate: `orders` and `order_items`, plus the rules about what
 * may be written into one and who may read it.
 *
 * Imports `UsersModule`, and only for one reason:
 *
 * - `UsersRepository` — to confirm the identity behind the temporary `X-User-Id`
 *   header is a real user before reading their orders. Without it a header naming a
 *   deleted user would return an empty list indistinguishable from "no orders yet".
 *
 * No other module is imported, and that is the interesting part. The orders feature
 * does **not** depend on `CartModule`: checkout does not exist yet, and when it does
 * it will depend on the cart, not the reverse. It reads `products`, `product_variants`
 * and `variant_options` for a checkout snapshot, but it does so through
 * {@link OrderRepository}'s own narrow read methods rather than through the sibling
 * repositories, so the edges stay one way and the orders feature owns the snapshot
 * it is about to write.
 *
 * `PrismaService` arrives without an explicit import because `PrismaModule` is
 * `@Global`.
 *
 * `OrderRepository` and `OrderService` are both exported for checkout.
 *
 * The service is exported so that placing an order has exactly one implementation:
 * checkout resolves its lines and writes its order through the same
 * {@link OrderService.resolveOrderLines} and {@link OrderService.writeOrder} that
 * {@link OrderService.placeOrder} uses, interleaving only the inventory reservation
 * that belongs to it. A checkout that re-derived the prices or re-wrote the money
 * arithmetic would be a second place for the totals to be wrong.
 *
 * Both take the caller's transaction client, which is what lets checkout run
 * resolve → reserve → write → clear the cart as one transaction.
 */
@Module({
  imports: [UsersModule],
  controllers: [OrderController],
  providers: [OrderRepository, OrderNumberGenerator, OrderService],
  exports: [OrderRepository, OrderService],
})
export class OrderModule {}