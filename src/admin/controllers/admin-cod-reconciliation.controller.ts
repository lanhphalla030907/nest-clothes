import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../auth/guards/roles.guard.js';
import { DeliveryService } from '../../delivery/delivery.service.js';
import { AdminCodReconciliationQueryDto } from '../../delivery/dto/admin-cod-reconciliation-query.dto.js';
import { ManualReconciliationTriggerDto } from '../../delivery/dto/manual-reconciliation-trigger.dto.js';
import { ReconciliationRunHistoryQueryDto } from '../../delivery/dto/reconciliation-run-history-query.dto.js';
import { ReconciliationService } from '../../delivery/reconciliation.service.js';
import type { CodReconciliationRun } from '../../generated/prisma/client.js';
import { Role } from '../../generated/prisma/enums.js';

/**
 * Administrative COD financial reconciliation: read-only.
 *
 * Every handler inherits `JwtAuthGuard` then `RolesGuard` with `@Roles(Role.ADMIN)`
 * from the class decorators. `RolesGuard` authorises against the database-backed
 * user row loaded by `JwtAuthGuard`, never against token claims, so delivery staff
 * and customers are refused before a service method runs.
 *
 * The controller is deliberately thin: it validates the query through
 * `AdminCodReconciliationQueryDto`, delegates to `DeliveryService`, and returns
 * the service's response DTOs. It never reads Prisma, a repository, or monetary
 * values for calculation.
 */
@Controller('admin/cod-reconciliation')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminCodReconciliationController {
  constructor(
    private readonly deliveryService: DeliveryService,
    private readonly reconciliationService: ReconciliationService,
  ) {}

  /**
   * `GET /admin/cod-reconciliation` — paginated COD reconciliation records.
   *
   * Filters cover the authoritative delivery date (`startDate`/`endDate`), staff,
   * order, order number, order status and currency. Sorting is limited by the DTO
   * to the accepted columns and directions.
   */
  @Get()
  findAll(@Query() query: AdminCodReconciliationQueryDto) {
    return this.deliveryService.getCodReconciliationRecords(query);
  }

  /**
   * `GET /admin/cod-reconciliation/summary` — currency-separated reconciliation
   * totals, discrepancy count, collection timestamps and the period/staff
   * breakdowns.
   */
  @Get('summary')
  summary(@Query() query: AdminCodReconciliationQueryDto) {
    return this.deliveryService.getCodReconciliationSummary(query);
  }

  /**
   * `GET /admin/cod-reconciliation/uncollected` — delivered COD orders that have
   * no recorded collection.
   *
   * `uncollected-orders` is kept as an alternate static path for clients that use
   * the longer name.
   */
  @Get(['uncollected', 'uncollected-orders'])
  uncollected(@Query() query: AdminCodReconciliationQueryDto) {
    return this.deliveryService.getUncollectedDeliveredCodOrders(query);
  }

  /**
   * `GET /admin/cod-reconciliation/discrepancies` — missing collections, amount
   * mismatches and currency mismatches classified by the repository.
   */
  @Get('discrepancies')
  discrepancies(@Query() query: AdminCodReconciliationQueryDto) {
    return this.deliveryService.getCodReconciliationDiscrepancies(query);
  }

  /**
   * `GET /admin/cod-reconciliation/by-staff` — collected, expected and
   * outstanding totals grouped by staff member and kept separate per currency.
   *
   * `staff` is kept as an alternate static path.
   */
  @Get(['by-staff', 'staff'])
  byStaff(@Query() query: AdminCodReconciliationQueryDto) {
    return this.deliveryService.getCodReconciliationByStaff(query);
  }

  /**
   * `GET /admin/cod-reconciliation/by-period` — collected, expected and
   * outstanding totals grouped by UTC calendar period and kept separate per
   * currency. `period` selects daily, weekly or monthly buckets.
   *
   * `period` is also accepted as an alternate static path.
   */
  @Get(['by-period', 'period'])
  byPeriod(@Query() query: AdminCodReconciliationQueryDto) {
    return this.deliveryService.getCodReconciliationByPeriod(query);
  }

  @Get('runs')
  async findRuns(@Query() query: ReconciliationRunHistoryQueryDto) {
    const history = await this.reconciliationService.getRunHistory({
      page: query.page,
      limit: query.limit,
      status: query.status,
      triggerType: query.triggerType,
      startDate: query.startDate
        ? new Date(`${query.startDate}T00:00:00.000Z`)
        : undefined,
      endDate: query.endDate
        ? this.endOfUtcDate(query.endDate)
        : undefined,
    });

    return {
      ...history,
      items: history.items.map((run) => this.sanitizeRunError(run)),
    };
  }

  @Get('runs/:id')
  async findRun(@Param('id', ParseUUIDPipe) id: string) {
    const run = await this.reconciliationService.getRun(id);
    return this.sanitizeRunError(run);
  }

  @Post('runs/trigger')
  async triggerRun(
    @Body() body: ManualReconciliationTriggerDto = new ManualReconciliationTriggerDto(),
  ) {
    if (!body || typeof body !== 'object') {
      throw new BadRequestException('Request body must be an object');
    }

    let windowStart: Date | undefined;
    let windowEnd: Date | undefined;

    if (body.date) {
      windowStart = new Date(`${body.date}T00:00:00.000Z`);
      windowEnd = new Date(windowStart);
      windowEnd.setUTCDate(windowEnd.getUTCDate() + 1);
    } else if (body.windowStart && body.windowEnd) {
      windowStart = new Date(body.windowStart);
      windowEnd = new Date(body.windowEnd);
    }

    const result = await this.reconciliationService.triggerManualReconciliation(
      windowStart,
      windowEnd,
    );

    return {
      ...result,
      run: this.sanitizeRunError(result.run),
    };
  }

  private endOfUtcDate(date: string): Date {
    const end = new Date(`${date}T00:00:00.000Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    end.setUTCMilliseconds(end.getUTCMilliseconds() - 1);
    return end;
  }

  private sanitizeRunError(run: CodReconciliationRun): CodReconciliationRun {
    return {
      ...run,
      errorMessage: run.status === 'failed' ? 'Reconciliation failed' : null,
    };
  }
}
