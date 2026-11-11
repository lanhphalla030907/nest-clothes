import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  CUSTOMER_LIST_DEFAULT_SORT_BY,
  CUSTOMER_LIST_DEFAULT_SORT_ORDER,
  CUSTOMER_RECENT_ORDERS_LIMIT,
  NEW_CUSTOMER_WINDOW_DAYS,
} from './customers.constants.js';
import {
  CustomersRepository,
  type AdminCustomerListFilters,
} from './customers.repository.js';
import type { AdminCustomerListQueryDto } from './dto/admin-customer-list-query.dto.js';
import { AdminCustomerListResponseDto } from './dto/admin-customer-list-response.dto.js';
import { AdminCustomerStatsResponseDto } from './dto/admin-customer-stats-response.dto.js';
import { AdminCustomerDetailResponseDto } from './dto/admin-customer-detail-response.dto.js';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Administrative customer reading service.
 *
 * The repository aggregates in PostgreSQL; this service validates the
 * cross-field query rules, resolves defaults, and maps rows to the response
 * DTOs. It performs no money arithmetic beyond the per-currency average the
 * detail response documents, and it changes nothing: every method is a read.
 *
 * **Reached only from `GET /admin/customers*`**, whose controller carries
 * `@Roles(Role.ADMIN)` on the class.
 */
@Injectable()
export class CustomersService {
  constructor(private readonly repository: CustomersRepository) {}

  /**
   * Returns one page of the customer listing.
   *
   * The date range is validated as two independently well-formed timestamps by
   * the DTO; their relative order is checked here because it is a cross-field
   * rule. `registeredFrom` and `registeredTo` are inclusive, which is what an
   * operator expects when they type a day boundary.
   */
  async listCustomers(
    query: AdminCustomerListQueryDto,
  ): Promise<AdminCustomerListResponseDto> {
    const registeredFrom = this.parseRegisteredDate(
      query.registeredFrom,
      'registeredFrom',
    );
    const registeredTo = this.parseRegisteredDate(
      query.registeredTo,
      'registeredTo',
    );

    if (
      registeredFrom !== undefined &&
      registeredTo !== undefined &&
      registeredFrom.getTime() > registeredTo.getTime()
    ) {
      throw new BadRequestException(
        'registeredFrom must not be later than registeredTo',
      );
    }

    const search = query.search?.trim();
    const filters: AdminCustomerListFilters = {
      page: query.page,
      limit: query.limit,
      search: search === undefined || search.length === 0 ? undefined : search,
      status: query.status,
      registeredFrom,
      registeredTo,
      orderActivity: query.orderActivity,
      sortBy: query.sortBy ?? CUSTOMER_LIST_DEFAULT_SORT_BY,
      sortOrder: query.sortOrder ?? CUSTOMER_LIST_DEFAULT_SORT_ORDER,
    };

    const result = await this.repository.findAdminPage(filters);

    return AdminCustomerListResponseDto.fromResult(
      result,
      query.page,
      query.limit,
    );
  }

  /**
   * Returns the four headline customer counters.
   *
   * The "new customer" cutoff is computed here rather than in the repository
   * so the window constant and the moment it is anchored to stay visible in
   * one place; the response echoes the window so the client can label the
   * figure.
   */
  async getStats(): Promise<AdminCustomerStatsResponseDto> {
    const newCustomersSince = new Date(
      Date.now() - NEW_CUSTOMER_WINDOW_DAYS * MILLISECONDS_PER_DAY,
    );

    const counts = await this.repository.getStats(newCustomersSince);

    return AdminCustomerStatsResponseDto.fromCounts(counts);
  }

  /**
   * Returns one customer, read-only, with order statistics, their most recent
   * orders and their address book.
   *
   * A missing customer is a 404 — and so is an `ADMIN` or `DELIVERY_STAFF`
   * id, because the repository's customer filter is in the query itself:
   * internal accounts are not customer records, and one message keeps that
   * from being probeable.
   */
  async getCustomer(
    id: string,
  ): Promise<AdminCustomerDetailResponseDto> {
    const row = await this.repository.findAdminCustomerById(id);

    if (row === null) {
      throw new NotFoundException(`Customer ${id} does not exist`);
    }

    const [recentOrders, addresses] = await Promise.all([
      this.repository.findRecentOrders(id, CUSTOMER_RECENT_ORDERS_LIMIT),
      this.repository.findAddresses(id),
    ]);

    return AdminCustomerDetailResponseDto.fromResult(row, recentOrders, addresses);
  }

  /**
   * Turns one validated ISO-8601 query value into a `Date`.
   *
   * The DTO has already refused a malformed timestamp, so the `Number.isNaN`
   * branch only protects an internal caller that bypasses HTTP validation. It is
   * still a 400 rather than a 500: the value is caller-shaped input even when
   * it arrives through the service.
   */
  private parseRegisteredDate(
    value: string | undefined,
    field: string,
  ): Date | undefined {
    if (value === undefined) {
      return undefined;
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(
        `${field} must be a valid ISO-8601 timestamp`,
      );
    }

    return date;
  }
}
