import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.js';
import { OrderResponseDto } from './dto/order-response.dto.js';
import { OrderSummaryResponseDto } from './dto/order-summary-response.dto.js';
import { OrderService } from './order.service.js';

/**
 * HTTP routing only: run the pipes, delegate to `OrderService`, return its result.
 * No business rules and no database access lives here.
 *
 * The controller is mounted under `/orders`, so every route acts on *the caller's*
 * orders. It is mounted with nothing else — no `POST`, `PATCH` or `DELETE` handler
 * exists, and there is no route anywhere in this feature that changes an order's
 * status, prices, totals, items or snapshots. That absence is deliberate and is the
 * reason the DTOs have no mutation affordances to advertise.
 *
 * ## Identity
 *
 * The caller is {@link CurrentUser}, resolved from a verified access token by
 * `JwtAuthGuard`. It replaced an `X-User-Id` header, which any caller could assert;
 * a request with no valid `Authorization: Bearer` header is now a 401 and the old
 * header is ignored, so there is no way to read another customer's orders.
 *
 * ## Which errors come from where
 *
 * `:id` runs through `ParseUUIDPipe`, so a malformed identifier is a 400 before the
 * service is reached. That keeps 404 reserved for a well-formed id that is absent or
 * not the caller's — and "absent" and "not yours" are deliberately the same 404, so
 * this endpoint cannot be used to probe for the existence of another user's order.
 */
@UseGuards(JwtAuthGuard)
@Controller('orders')
export class OrderController {
  constructor(private readonly orderService: OrderService) {}

  /**
   * `GET /orders` — the caller's orders, newest first.
   *
   * Returns order summaries rather than full orders: a listing carries the fields a
   * client needs to draw a row (reference, status, money, a recipient and city to
   * recognise it by, and counts) and deliberately omits the full shipping address,
   * which the detail view carries. See {@link OrderSummaryResponseDto} for why the
   * two responses are separate types.
   *
   * An empty array is a success, not a 404.
   */
  @Get()
  listOrders(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OrderSummaryResponseDto[]> {
    return this.orderService.listOrders(user.id);
  }

  @Get(':id')
  getOrder(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<OrderResponseDto> {
    return this.orderService.getOrder(user.id, id);
  }
}
