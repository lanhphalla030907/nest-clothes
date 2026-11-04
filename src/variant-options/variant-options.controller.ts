import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
} from '@nestjs/common';
import { VariantOptionResponseDto } from './dto/variant-option-response.dto.js';
import { VariantOptionsService } from './variant-options.service.js';

/**
 * Public read-only option routes. Mutations are available only from the
 * role-guarded admin controller.
 *
 * The controller is mounted under
 * `/products/:productId/variants/:variantId/options`, so every option is
 * addressed through the whole ownership chain: the product, then the variant,
 * then the option. All three path parameters run through `ParseUUIDPipe`, which
 * rejects a malformed id with 400 before the service is reached — so the service
 * only ever sees well-formed identifiers, and 404 stays reserved for a
 * well-formed id that does not exist or does not belong to its parent.
 */
@Controller('products/:productId/variants/:variantId/options')
export class VariantOptionsController {
  constructor(private readonly variantOptionsService: VariantOptionsService) {}

  @Get()
  findAll(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
  ): Promise<VariantOptionResponseDto[]> {
    return this.variantOptionsService.findAllByVariantId(productId, variantId);
  }

  @Get(':optionId')
  findOne(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Param('optionId', ParseUUIDPipe) optionId: string,
  ): Promise<VariantOptionResponseDto> {
    return this.variantOptionsService.findOne(productId, variantId, optionId);
  }

}
