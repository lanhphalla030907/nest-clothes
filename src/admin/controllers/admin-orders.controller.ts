import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../auth/guards/roles.guard.js';
import { Role } from '../../generated/prisma/enums.js';
import { AdminOrderListQueryDto } from '../../orders/dto/admin-order-list-query.dto.js';
import { AdminOrderListResponseDto } from '../../orders/dto/admin-order-list-response.dto.js';
import { AdminOrderDetailResponseDto } from '../../orders/dto/admin-order-detail-response.dto.js';
import { OrderService } from '../../orders/order.service.js';

/**
 * Administrative order management: reads plus two explicit lifecycle actions.
 *
 * The business rules and query shapes live in `OrderService` and
 * `OrderRepository`, next to the customer-facing order reads they extend. This
 * controller adds authority, not a second implementation: it is the only route
 * that may read or mutate an order without an ownership filter.
 *
 * `JwtAuthGuard` then `RolesGuard` with `@Roles(Role.ADMIN)` are declared on the
 * class, so both handlers inherit them and a future handler cannot be added
 * without them. The role is read from the database-backed user row, never from a
 * token claim.
 *
 * There is deliberately no arbitrary status field and no generic `PATCH /:id`.
 * Cancellation and shipment are named actions with their own rules and inventory
 * movements; every other transition, including refunds, remains out of scope.
 */
@Controller('admin/orders')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminOrdersController {
  constructor(private readonly orderService: OrderService) {}

  /**
   * `GET /admin/orders` — every customer's orders, newest first.
   *
   * Pagination, status, search and date filters are validated by
   * {@link AdminOrderListQueryDto}; unknown query parameters are refused by the
   * global `ValidationPipe` rather than ignored.
   */
  @Get()
  findAll(
    @Query() query: AdminOrderListQueryDto,
  ): Promise<AdminOrderListResponseDto> {
    return this.orderService.listOrdersForAdmin(query);
  }

  /**
   * `POST /admin/orders/:id/cancel` — cancel an unpaid order and release its hold.
   *
   * The order must be `PENDING` and must not have a verified payment. `OrderService`
   * owns those rules and performs the status guard, payment check and reservation
   * release in one transaction. A repeated request is a 409, not a second release.
   */
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AdminOrderDetailResponseDto> {
    return this.orderService.cancelOrderForAdmin(id);
  }

  /**
   * `POST /admin/orders/:id/ship` — ship a confirmed, paid order.
   *
   * The order must be `CONFIRMED` and have at least one verified `PAID` payment.
   * The status update and the inventory commitment share one transaction, so a
   * repeated request is a 409 and can never commit the same stock twice.
   */
  @Post(':id/ship')
  @HttpCode(HttpStatus.OK)
  ship(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AdminOrderDetailResponseDto> {
    return this.orderService.shipOrderForAdmin(id);
  }

  /**
   * `GET /admin/orders/:id` — one order with its snapshots and payment attempts.
   *
   * `ParseUUIDPipe` makes a malformed id a 400 before the service runs, so a 404
   * means a well-formed id that does not exist.
   */
  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AdminOrderDetailResponseDto> {
    return this.orderService.getOrderForAdmin(id);
  }
}
