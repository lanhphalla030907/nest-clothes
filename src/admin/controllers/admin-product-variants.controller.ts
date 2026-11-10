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
import { CurrentUser } from '../../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../../auth/types/authenticated-user.js';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../auth/guards/roles.guard.js';
import { Role } from '../../generated/prisma/enums.js';
import { AdminProductVariantResponseDto } from '../../product-variants/dto/admin-product-variant-response.dto.js';
import { CreateProductVariantDto } from '../../product-variants/dto/create-product-variant.dto.js';
import { UpdateProductVariantDto } from '../../product-variants/dto/update-product-variant.dto.js';
import { UpdateVariantCostDto } from '../../product-variants/dto/update-variant-cost.dto.js';
import { BulkUpdateVariantCostDto } from '../../product-variants/dto/bulk-update-variant-cost.dto.js';
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
  ): Promise<AdminProductVariantResponseDto[]> {
    return this.productVariantsService.findAllAdminByProductId(productId);
  }

  @Get(':variantId')
  findOne(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
  ): Promise<AdminProductVariantResponseDto> {
    return this.productVariantsService.findOneAdmin(productId, variantId);
  }

  @Post()
  create(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: CreateProductVariantDto,
  ): Promise<AdminProductVariantResponseDto> {
    return this.productVariantsService.create(productId, dto);
  }

  /** Updates the SKU, the price or the enablement flag of a variant of this product. */
  @Patch(':variantId')
  update(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Body() dto: UpdateProductVariantDto,
  ): Promise<AdminProductVariantResponseDto> {
    return this.productVariantsService.update(productId, variantId, dto);
  }

  @Patch(':variantId/cost')
  updateCost(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Body() dto: UpdateVariantCostDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AdminProductVariantResponseDto> {
    return this.productVariantsService.updateCost(productId, variantId, dto, user.id);
  }

  /**
   * Applies one purchase cost to many variants of this product in a single
   * request. Each variant's cost history ledger is updated independently, so
   * historical `OrderItem.unitCostSnapshot` rows are never touched.
   */
  @Patch('cost/bulk')
  updateVariantCosts(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: BulkUpdateVariantCostDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AdminProductVariantResponseDto[]> {
    return this.productVariantsService.updateVariantCosts(productId, dto, user.id);
  }

  /**
   * Retires a variant without deleting its inventory or transaction references.
   *
   * Obsolete variants are retained so existing cart and order references remain valid.
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
