import { Module } from '@nestjs/common';
import { ReceiptDataService } from './receipt-data.service.js';
import { ReceiptController } from './receipt.controller.js';
import { AdminReceiptController } from './receipt.controller.js';
import { JwtAuthModule } from '../auth/jwt/jwt-auth.module.js';
import { OrderModule } from '../orders/order.module.js';
import { UsersModule } from '../users/users.module.js';

/**
 * Order receipt feature: PDF generation and download endpoints.
 *
 * Depends on `OrderModule` for `OrderRepository` and `UsersModule` for
 * `UsersRepository`, which `ReceiptDataService` uses to fetch order data
 * through the existing, authorization-safe paths.
 *
 * Both controllers are role-gated: `ReceiptController` mounts `JwtAuthGuard`
 * (caller's own orders only) and `AdminReceiptController` mounts `JwtAuthGuard`
 * plus `RolesGuard` (any order, ADMIN only). `JwtAuthModule` is imported
 * explicitly because NestJS module imports are not transitive — `OrderModule`
 * imports `JwtAuthModule` but does not re-export it.
 */
@Module({
  imports: [JwtAuthModule, OrderModule, UsersModule],
  providers: [ReceiptDataService],
  controllers: [ReceiptController, AdminReceiptController],
})
export class ReceiptModule {}
