import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ProductVariantResponseDto } from './dto/product-variant-response.dto.js';
import { ProductVariantsService } from './product-variants.service.js';

/**
 * Public read-only variant routes. Mutations are available only from the
 * role-guarded admin controller.
 *
 * The controller is mounted under `/products/:productId/variants`, so every
 * variant is addressed through the product that owns it. Both path parameters run
 * through `ParseUUIDPipe`, which rejects a malformed id with 400 before the
 * service is reached — so the service only ever sees well-formed identifiers, and
 * 404 stays reserved for a well-formed id that does not exist or does not belong
 * to the product in the path.
 */
@Controller('products/:productId/variants')
export class ProductVariantsController {
  constructor(
    private readonly productVariantsService: ProductVariantsService,
  ) {}

  @Get()
  findAll(
    @Param('productId', ParseUUIDPipe) productId: string,
  ): Promise<ProductVariantResponseDto[]> {
    return this.productVariantsService.findAllByProductId(productId);
  }

  @Get(':variantId')
  findOne(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
  ): Promise<ProductVariantResponseDto> {
    return this.productVariantsService.findOne(productId, variantId);
  }

}
