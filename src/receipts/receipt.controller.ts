import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.js';
import { Role } from '../generated/prisma/enums.js';
import type { Response as ExpressResponse } from 'express';
import { ReceiptDataService } from './receipt-data.service.js';
import { renderReceiptToStream } from './receipt-pdf.service.js';
import { sanitizeFilename } from './receipt-filename.js';

/**
 * Order receipt endpoints: download an A4 PDF receipt for one order.
 *
 * Two routes serve the same underlying data but with different authorization:
 *
 * - `GET /orders/:id/receipt` — the caller's own orders only. `JwtAuthGuard`
 *   plus ownership scoping in `ReceiptDataService`. A 404 is returned for both
 *   "absent" and "not yours", so the endpoint cannot probe another customer's
 *   orders.
 *
 * - `GET /admin/orders/:id/receipt` — any order, restricted to `ADMIN` by
 *   `RolesGuard`. No ownership check.
 *
 * `DELIVERY_STAFF` has no access to either route — no role grant exists for it.
 *
 * Both routes stream a PDF directly to the response with
 * `Content-Type: application/pdf` and a sanitized filename.
 */
@Controller('orders')
@UseGuards(JwtAuthGuard)
export class ReceiptController {
  constructor(private readonly receiptData: ReceiptDataService) {}

  /**
   * `GET /orders/:id/receipt` — download a receipt for one of the caller's
   * own orders.
   */
  @Get(':id/receipt')
  async getReceiptForCustomer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: ExpressResponse,
  ): Promise<void> {
    const data = await this.receiptData.getReceiptDataForCustomer(user.id, id);

    const filename = sanitizeFilename(data.orderNumber);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}.pdf"`,
    });

    renderReceiptToStream(data, res);
  }
}

/**
 * Administrative order receipt endpoint.
 *
 * Mounted under `/admin/orders` with `RolesGuard` + `@Roles(Role.ADMIN)` on
 * the class, so every handler inherits admin-only authorization.
 */
@Controller('admin/orders')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminReceiptController {
  constructor(private readonly receiptData: ReceiptDataService) {}

  /**
   * `GET /admin/orders/:id/receipt` — download a receipt for any order.
   */
  @Get(':id/receipt')
  async getReceiptForAdmin(
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: ExpressResponse,
  ): Promise<void> {
    const data = await this.receiptData.getReceiptDataForAdmin(id);

    const filename = sanitizeFilename(data.orderNumber);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}.pdf"`,
    });

    renderReceiptToStream(data, res);
  }
}
