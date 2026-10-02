import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { CreateProductVariantDto } from './dto/create-product-variant.dto.js';
import { ProductVariantResponseDto } from './dto/product-variant-response.dto.js';
import { UpdateProductVariantDto } from './dto/update-product-variant.dto.js';
import { ProductVariantsService } from './product-variants.service.js';

/**
 * HTTP routing only: parse the request through the pipes and DTOs, delegate to
 * `ProductVariantsService`, return its result. No business rules and no database
 * access live here.
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

  @Post()
  create(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: CreateProductVariantDto,
  ): Promise<ProductVariantResponseDto> {
    return this.productVariantsService.create(productId, dto);
  }

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

  @Patch(':variantId')
  update(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Body() dto: UpdateProductVariantDto,
  ): Promise<ProductVariantResponseDto> {
    return this.productVariantsService.update(productId, variantId, dto);
  }

  @Delete(':variantId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
  ): Promise<void> {
    return this.productVariantsService.remove(productId, variantId);
  }
}
