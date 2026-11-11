import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { Role } from '../generated/prisma/enums.js';
import { AdminCustomerListQueryDto } from './dto/admin-customer-list-query.dto.js';
import { AdminCustomerListResponseDto } from './dto/admin-customer-list-response.dto.js';
import { AdminCustomerStatsResponseDto } from './dto/admin-customer-stats-response.dto.js';
import { AdminCustomerDetailResponseDto } from './dto/admin-customer-detail-response.dto.js';
import { CustomersService } from './customers.service.js';

/**
 * Administrative customer management: read-only.
 *
 * Every handler inherits `JwtAuthGuard` then `RolesGuard` with
 * `@Roles(Role.ADMIN)` from the class decorators. `RolesGuard` authorises
 * against the database-backed user row loaded by `JwtAuthGuard`, never against
 * token claims, so customers and delivery staff are refused before a service
 * method runs.
 *
 * The controller is deliberately thin: it validates the query through the
 * DTOs, delegates to `CustomersService`, and returns the service's response
 * objects. It never reads Prisma and performs no monetary arithmetic.
 *
 * There are deliberately no write routes: no customer edit, no customer
 * delete, no status change. The feature exists to observe customers, and a
 * route that cannot mutate a customer cannot mutate one by mistake.
 */
@Controller('admin/customers')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  /**
   * `GET /admin/customers/stats` — the four headline counters.
   *
   * Declared **before** the `:id` route: Nest registers routes in declaration
   * order, so a literal segment must come first or `stats` would be parsed as
   * a customer id.
   */
  @Get('stats')
  stats(): Promise<AdminCustomerStatsResponseDto> {
    return this.customersService.getStats();
  }

  /**
   * `GET /admin/customers` — one page of the customer listing.
   *
   * Pagination, search, status, registration-date range, order-activity and
   * sorting filters are validated by {@link AdminCustomerListQueryDto};
   * unknown query parameters are refused by the global `ValidationPipe`
   * rather than ignored.
   */
  @Get()
  findAll(
    @Query() query: AdminCustomerListQueryDto,
  ): Promise<AdminCustomerListResponseDto> {
    return this.customersService.listCustomers(query);
  }

  /**
   * `GET /admin/customers/:id` — one customer, read-only.
   *
   * `ParseUUIDPipe` makes a malformed id a 400 before the service runs, so a
   * 404 means a well-formed id that is not a customer.
   */
  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AdminCustomerDetailResponseDto> {
    return this.customersService.getCustomer(id);
  }
}
