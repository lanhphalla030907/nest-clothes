import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../auth/guards/roles.guard.js';
import { Role } from '../../generated/prisma/enums.js';
import { DeliveryService } from '../../delivery/delivery.service.js';
import { AdminCodCollectionsQueryDto } from '../../delivery/dto/admin-cod-collections-query.dto.js';

/**
 * Administrative COD collection management: read-only.
 *
 * Every handler is behind `JwtAuthGuard` then `RolesGuard` with `@Roles(Role.ADMIN)`,
 * declared on the class so a future handler cannot be added without them. The role is
 * read from the database-backed user row, never from a token claim.
 *
 * Delivery staff and other roles are refused at `RolesGuard` before any service method
 * runs, so an administrator's reads are never reachable by a courier.
 */
@Controller('admin/cod-collections')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminCodCollectionsController {
  constructor(private readonly deliveryService: DeliveryService) {}

  /**
   * `GET /admin/cod-collections` — every COD collection in the shop, paginated,
   * filtered and deterministically sorted.
   *
   * The listing is not scoped to a caller: an administrator may read any
   * collection, including another staff member's. Order and collecting-staff
   * information are hydrated in the same query, so the page never becomes N+1.
   */
  @Get()
  findAll(@Query() query: AdminCodCollectionsQueryDto) {
    return this.deliveryService.getCodCollectionsForAdmin(query);
  }

  /**
   * `GET /admin/cod-collections/summary` — aggregated COD collection totals.
   *
   * Amounts are aggregated per currency and never mixed: `totalsByCurrency` is
   * authoritative, and every `periodBreakdown`/`staffBreakdown` row keeps its
   * own currency.
   *
   * Declared before the parameterised `:id` route: `summary` is a static
   * segment, and Express matches routes in registration order, so `:id` must
   * not shadow it.
   */
  @Get('summary')
  summary(@Query() query: AdminCodCollectionsQueryDto) {
    return this.deliveryService.getCodCollectionsSummaryForAdmin(query);
  }

  /**
   * `GET /admin/cod-collections/:id` — one COD collection with its order, the
   * collecting delivery staff member and the linked payment attempt, if any.
   *
   * Customer PII is deliberately absent. A well-formed id that does not exist is
   * a 404.
   */
  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.deliveryService.getCodCollectionForAdminById(id);
  }
}
