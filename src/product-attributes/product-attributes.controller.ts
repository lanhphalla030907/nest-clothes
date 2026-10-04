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
import { CreateProductAttributeDto } from './dto/create-product-attribute.dto.js';
import { ProductAttributeResponseDto } from './dto/product-attribute-response.dto.js';
import { UpdateProductAttributeDto } from './dto/update-product-attribute.dto.js';
import { ProductAttributesService } from './product-attributes.service.js';

/**
 * HTTP routing only: parse the request through the pipes and DTOs, delegate to
 * `ProductAttributesService`, return its result. No business rules and no
 * database access live here.
 *
 * The controller is mounted under `/products/:productId/attributes`, so every
 * attribute is addressed through its owning product. Both path parameters run
 * through `ParseUUIDPipe`, which rejects a malformed id with 400 before the
 * service is reached — so the service only ever sees well-formed identifiers, and
 * 404 stays reserved for a well-formed id that does not exist or does not belong
 * to its product.
 */
@Controller('products/:productId/attributes')
export class ProductAttributesController {
  constructor(
    private readonly productAttributesService: ProductAttributesService,
  ) {}

  @Post()
  create(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: CreateProductAttributeDto,
  ): Promise<ProductAttributeResponseDto> {
    return this.productAttributesService.create(productId, dto);
  }

  @Get()
  findAll(
    @Param('productId', ParseUUIDPipe) productId: string,
  ): Promise<ProductAttributeResponseDto[]> {
    return this.productAttributesService.findAllByProductId(productId);
  }

  @Get(':attributeId')
  findOne(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('attributeId', ParseUUIDPipe) attributeId: string,
  ): Promise<ProductAttributeResponseDto> {
    return this.productAttributesService.findOne(productId, attributeId);
  }

  @Patch(':attributeId')
  update(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('attributeId', ParseUUIDPipe) attributeId: string,
    @Body() dto: UpdateProductAttributeDto,
  ): Promise<ProductAttributeResponseDto> {
    return this.productAttributesService.update(productId, attributeId, dto);
  }

  @Delete(':attributeId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('attributeId', ParseUUIDPipe) attributeId: string,
  ): Promise<void> {
    return this.productAttributesService.remove(productId, attributeId);
  }
}
