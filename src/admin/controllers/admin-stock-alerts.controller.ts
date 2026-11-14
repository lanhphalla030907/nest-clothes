import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../auth/guards/roles.guard.js';
import { Role } from '../../generated/prisma/enums.js';
import { StockAlertsQueryDto } from '../../inventory/dto/stock-alerts-query.dto.js';
import { StockAlertsResponseDto } from '../../inventory/dto/stock-alerts-response.dto.js';
import { InventoryService } from '../../inventory/inventory.service.js';

/**
 * Read-only stock alerts for the admin dashboard and the product overview page.
 *
 * The route is admin-only by the same two guards every other admin route uses:
 * `JwtAuthGuard` verifies the identity and `RolesGuard` compares the role stored
 * on that identity with `ADMIN`, so a customer token cannot read stock counts.
 *
 * The controller holds no stock rule: `available = quantity - reservedQuantity`
 * and the low/out thresholds live in `InventoryService`, beside the counters they
 * are derived from. Pagination, search and the status filter are validated by
 * {@link StockAlertsQueryDto} and applied in the database before the page is
 * sliced, so the client never receives more rows than it needs.
 */
@Controller('admin/inventory')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminStockAlertsController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Get('stock-alerts')
  findStockAlerts(
    @Query() query: StockAlertsQueryDto,
  ): Promise<StockAlertsResponseDto> {
    return this.inventoryService.findStockAlerts(query);
  }
}
