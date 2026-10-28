import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../auth/guards/roles.guard.js';
import { Role } from '../../generated/prisma/enums.js';
import { CreateInventoryDto } from '../../inventory/dto/create-inventory.dto.js';
import { InventoryResponseDto } from '../../inventory/dto/inventory-response.dto.js';
import { UpdateInventoryDto } from '../../inventory/dto/update-inventory.dto.js';
import { InventoryService } from '../../inventory/inventory.service.js';

/**
 * Administrative inventory management.
 *
 * ## Why this delegates rather than implementing its own stock logic
 *
 * Stock is the one part of the catalogue where a "reasonable-looking" admin
 * implementation is a correctness bug. The rules are not just validation:
 *
 * - a `PATCH` sends **absolute** counters, and the service reads the row *inside a
 *   transaction*, merges the counters the request left out, validates the merged pair and
 *   writes only the counters the request named — so two administrators changing different
 *   counters at once do not clobber each other;
 * - the table's `CHECK` constraints are the backstop, and a `P2004`/`23514` from a
 *   concurrent checkout reservation is translated to a 400 rather than surfacing as a
 *   500;
 * - checkout reserves stock through `InventoryRepository.reserve`, a single guarded
 *   `UPDATE … WHERE quantity - reserved_quantity >= n`, and it is deliberately the only
 *   reservation path. Adding an admin path that incremented `reservedQuantity` directly
 *   would be a second one, and the first thing it would break is overselling.
 *
 * So this route is a thin, role-gated shell over {@link InventoryService}. The invariants
 * are enforced by the same code whether the caller is a customer checking out or an
 * administrator correcting a stock count.
 *
 * ## `reservedQuantity` on a create is a starting balance
 *
 * `POST` accepts it because a fresh row may legitimately start with stock already
 * promised — a migrated or manually reconciled count. It defaults to `0`, and
 * `reservedQuantity <= quantity` is checked before the write either way. Nothing about
 * that makes it a way to *hold* stock: holding is `reserve`, and only checkout calls it.
 *
 * Ownership is the service's, and it is the three-segment form: the product must exist
 * and the variant must belong to it, so inventory for a variant of another product is a
 * 404 rather than a 403.
 */
@Controller('admin/products/:productId/variants/:variantId/inventory')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminInventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  /**
   * Reads the counters for a variant, with the derived `available` amount.
   *
   * 404 when the variant has no inventory row — the resource is absent rather than empty,
   * and `POST` is how one is created.
   */
  @Get()
  findOne(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
  ): Promise<InventoryResponseDto> {
    return this.inventoryService.findOne(productId, variantId);
  }

  /** Creates the single inventory row for a variant, or 409s if it already has one. */
  @Post()
  create(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Body() dto: CreateInventoryDto,
  ): Promise<InventoryResponseDto> {
    return this.inventoryService.create(productId, variantId, dto);
  }

  /**
   * Sets the counters.
   *
   * Absolute values, merged with the current row inside the service's transaction. The
   * ownership id is not accepted from the body: `variantId` is absent from
   * `UpdateInventoryDto`, and the global pipe forbids unknown keys, so stock cannot be
   * moved between variants by any write.
   */
  @Patch()
  update(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Body() dto: UpdateInventoryDto,
  ): Promise<InventoryResponseDto> {
    return this.inventoryService.update(productId, variantId, dto);
  }
}