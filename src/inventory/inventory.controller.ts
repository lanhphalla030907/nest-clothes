import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { CreateInventoryDto } from './dto/create-inventory.dto.js';
import { InventoryResponseDto } from './dto/inventory-response.dto.js';
import { UpdateInventoryDto } from './dto/update-inventory.dto.js';
import { InventoryService } from './inventory.service.js';

/**
 * HTTP routing only: parse the request through the pipes and DTOs, delegate to
 * `InventoryService`, return its result. No business rules and no database access
 * live here.
 *
 * The controller is mounted under
 * `/products/:productId/variants/:variantId/inventory`. There is exactly one
 * inventory row per variant, so the route addresses it without a third id. Both
 * path parameters run through `ParseUUIDPipe`, which rejects a malformed id with
 * 400 before the service is reached — so 404 stays reserved for a well-formed id
 * that does not exist or does not belong to its parent.
 */
@Controller('products/:productId/variants/:variantId/inventory')
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Post()
  create(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Body() dto: CreateInventoryDto,
  ): Promise<InventoryResponseDto> {
    return this.inventoryService.create(productId, variantId, dto);
  }

  @Get()
  findOne(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
  ): Promise<InventoryResponseDto> {
    return this.inventoryService.findOne(productId, variantId);
  }

  @Patch()
  update(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Body() dto: UpdateInventoryDto,
  ): Promise<InventoryResponseDto> {
    return this.inventoryService.update(productId, variantId, dto);
  }
}
