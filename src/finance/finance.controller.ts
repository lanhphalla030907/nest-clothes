import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { Role } from '../generated/prisma/enums.js';
import { CashReconciliationQueryDto } from './dto/cash-reconciliation-query.dto.js';
import { FinanceQueryDto } from './dto/finance-query.dto.js';
import { ProductProfitQueryDto } from './dto/product-profit-query.dto.js';
import { RankingsQueryDto } from './dto/rankings-query.dto.js';
import { RevenueTrendQueryDto } from './dto/revenue-trend-query.dto.js';
import { FinanceService } from './finance.service.js';

/**
 * Administrative finance and profit reporting: read-only.
 *
 * Every handler inherits `JwtAuthGuard` then `RolesGuard` with
 * `@Roles(Role.ADMIN)` from the class decorators. `RolesGuard` authorises
 * against the database-backed user row loaded by `JwtAuthGuard`, never against
 * token claims, so customers and delivery staff are refused before a service
 * method runs.
 *
 * The controller is deliberately thin: it validates the query through the
 * DTOs, delegates to `FinanceService`, and returns the service's response
 * objects. It never reads Prisma or performs monetary arithmetic.
 */
@Controller('admin/finance')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class FinanceController {
  constructor(private readonly financeService: FinanceService) {}

  /**
   * `GET /admin/finance/overview` — revenue, discounts, known-cost profit,
   * margin, cost coverage, cash and receivables for the reporting window.
   */
  @Get('overview')
  overview(@Query() query: FinanceQueryDto) {
    return this.financeService.getOverview(query);
  }

  /**
   * `GET /admin/finance/revenue-trend` — daily, weekly or monthly buckets in
   * the `Asia/Phnom_Penh` reporting timezone.
   */
  @Get('revenue-trend')
  revenueTrend(@Query() query: RevenueTrendQueryDto) {
    return this.financeService.getRevenueTrend(query);
  }

  /**
   * `GET /admin/finance/products` — paginated product/variant revenue, COGS,
   * profit and cost coverage.
   */
  @Get('products')
  products(@Query() query: ProductProfitQueryDto) {
    return this.financeService.getProductProfitability(query);
  }

  /**
   * `GET /admin/finance/rankings` — top products per currency by revenue,
   * known-cost profit or units sold.
   */
  @Get('rankings')
  rankings(@Query() query: RankingsQueryDto) {
    return this.financeService.getRankings(query);
  }

  /**
   * `GET /admin/finance/cash-reconciliation` — online cash, confirmed COD
   * cash, orphan cash, deferred cash, COD receivables and unpaid online orders.
   */
  @Get('cash-reconciliation')
  cashReconciliation(@Query() query: CashReconciliationQueryDto) {
    return this.financeService.getCashReconciliation(query);
  }
}
