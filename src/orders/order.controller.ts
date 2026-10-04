import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
} from '@nestjs/common';
import { TemporaryUserId } from '../common/decorators/temporary-user-id.decorator.js';
import { OrderResponseDto } from './dto/order-response.dto.js';
import { OrderSummaryResponseDto } from './dto/order-summary-response.dto.js';
import { OrderService } from './order.service.js';

/**
 * HTTP routing only: run the pipes, delegate to `OrderService`, return its result.
 * No business rules and no database access live here.
 *
 * The controller is mounted under `/orders`, so every route acts on *the caller's*
 * orders. It is mounted with nothing else — no `POST`, `PATCH` or `DELETE` handler
 * exists, and there is no route anywhere in this feature that changes an order's
 * status, prices, totals, items or snapshots. That absence is deliberate and is the
 * reason the DTOs have no mutation affordances to advertise.
 *
 * ## Identity
 *
 * The caller is {@link TemporaryUserId}, the `X-User-Id` stand-in that exists
 * because authentication does not yet. It is a claim, not proof of identity, and the
 * service confirms the claimed user is real before reading anything. The controller
 * receives the user id as an ordinary parameter and mounts no guard of its own, so
 * replacing the decorator with a real guard is a change to this one decorator rather
 * than to every route.
 *
 * ## Which errors come from where
 *
 * `:id` runs through `ParseUUIDPipe`, so a malformed identifier is a 400 before the
 * service is reached. That keeps 404 reserved for a well-formed id that is absent or
 * not the caller's — and "absent" and "not yours" are deliberately the same 404, so
 * this endpoint cannot be used to probe for the existence of another user's order.
 */
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
    @TemporaryUserId(new ParseUUIDPipe()) userId: string,
  ): Promise<OrderSummaryResponseDto[]> {
    return this.orderService.listOrders(userId);
  }

  /**
   * `GET /orders/:id` — one of the caller's orders, with its items.
   *
   * | Condition                              | Status |
   * | -------------------------------------- | ------ |
   * | Malformed `:id`, or missing/malformed `X-User-Id` | 400 |
   * | Claimed user does not exist            | 404    |
   * | Order absent, or owned by another user | 404    |
   *
   * The 404 is shared on purpose: telling the two apart would confirm that an order
   * id exists, which is itself information a caller should not have.
   */
  @Get(':id')
  getOrder(
    @TemporaryUserId(new ParseUUIDPipe()) userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<OrderResponseDto> {
    return this.orderService.getOrder(userId, id);
  }
}