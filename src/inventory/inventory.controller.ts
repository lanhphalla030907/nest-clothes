import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
} from '@nestjs/common';
import { InventoryResponseDto } from './dto/inventory-response.dto.js';
import { InventoryService } from './inventory.service.js';

/**
 * Public read-only inventory route. Mutations are available only from the
 * role-guarded admin controller.
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

  @Get()
  findOne(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
  ): Promise<InventoryResponseDto> {
    return this.inventoryService.findOne(productId, variantId);
  }

}
