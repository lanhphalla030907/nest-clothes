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
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../auth/guards/roles.guard.js';
import { Role } from '../../generated/prisma/enums.js';
import { CreateProductVariantDto } from '../../product-variants/dto/create-product-variant.dto.js';
import { ProductVariantResponseDto } from '../../product-variants/dto/product-variant-response.dto.js';
import { UpdateProductVariantDto } from '../../product-variants/dto/update-product-variant.dto.js';
import { ProductVariantsService } from '../../product-variants/product-variants.service.js';

/**
 * Administrative product-variant management.
 *
 * Delegates to {@link ProductVariantsService}, so the SKU trim-and-uppercase
 * normalisation, the catalogue-wide uniqueness 409, the positive-price rule and the
 * product-ownership chain are one implementation shared with the public routes rather
 * than a second one.
 *
 * Ownership is the property that matters most here and it is the service's: a variant is
 * only ever loaded through `findByIdAndProductId`, so a variant belonging to another
 * product is a 404 under this route and not a 403. It is indistinguishable from a variant
 * that does not exist, which is what stops an administrator's id from being used to
 * confirm that another product's variant is real. `productId` is never read from a body,
 * and `UpdateProductVariantDto` has no such field, so a variant cannot be moved to
 * another product by any write.
 *
 * Every response is a {@link ProductVariantResponseDto}: the entity is mapped field by
 * field, so no internal Prisma object and no nested relation is ever returned.
 */
@Controller('admin/products/:productId/variants')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminProductVariantsController {
  constructor(private readonly productVariantsService: ProductVariantsService) {}

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

  @Post()
  create(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: CreateProductVariantDto,
  ): Promise<ProductVariantResponseDto> {
    return this.productVariantsService.create(productId, dto);
  }

  /** Updates the SKU, the price or the enablement flag of a variant of this product. */
  @Patch(':variantId')
  update(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Body() dto: UpdateProductVariantDto,
  ): Promise<ProductVariantResponseDto> {
    return this.productVariantsService.update(productId, variantId, dto);
  }

  /**
   * Deletes a variant.
   *
   * Its options and inventory cascade with it. A variant still held by a cart or an order
   * is refused by PostgreSQL (`ON DELETE RESTRICT`) rather than removed out from under
   * those rows; deactivating it is the alternative.
   */
  @Delete(':variantId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
  ): Promise<void> {
    return this.productVariantsService.remove(productId, variantId);
  }
}