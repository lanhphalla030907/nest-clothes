import { Module } from '@nestjs/common';
import { AddressesModule } from '../addresses/addresses.module.js';
import { CartModule } from '../cart/cart.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { OrderModule } from '../orders/order.module.js';
import { UsersModule } from '../users/users.module.js';
import { CheckoutController } from './checkout.controller.js';
import { CheckoutService } from './checkout.service.js';

/**
 * Owns the checkout aggregate: the one operation that turns a cart into an order.
 *
 * It has no tables of its own. It is a *coordination* feature — it composes the cart,
 * the address book, the catalogue, the inventory ledger and the orders — and its
 * value is entirely in the order it does those things in and the single transaction
 * they share. That is why every module below is imported for a repository or a
 * service and not for behaviour:
 *
 * - `CartModule` → `CartRepository`. The query surface, not `CartService`: the cart
 *   must be read and emptied inside the checkout transaction, which a service method
 *   opening its own transaction could not do.
 * - `InventoryModule` → `InventoryRepository`. The guarded reservation statement, so
 *   the stock rule has exactly one implementation.
 * - `OrderModule` → `OrderService`. Resolving lines (existence, sellability, the
 *   current price, the option snapshot) and writing the order with its money
 *   arithmetic, so totals are computed in one place for the whole application.
 * - `AddressesModule` → `AddressesService`. Reading a user's address, so ownership
 *   stays the address book's rule to enforce.
 * - `UsersModule` → `UsersRepository`. Confirming the claimed `X-User-Id` is a real
 *   user before an order is created against it.
 *
 * `CheckoutService` is not exported: nothing composes a checkout, and a second entry
 * point to it would be a second way to place an order outside the transaction this
 * module defines.
 *
 * `PrismaService` arrives without an explicit import because `PrismaModule` is
 * `@Global`.
 */
@Module({
  imports: [
    UsersModule,
    CartModule,
    InventoryModule,
    OrderModule,
    AddressesModule,
  ],
  controllers: [CheckoutController],
  providers: [CheckoutService],
})
export class CheckoutModule {}
