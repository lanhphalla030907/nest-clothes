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
import { CreateVariantOptionDto } from '../../variant-options/dto/create-variant-option.dto.js';
import { UpdateVariantOptionDto } from '../../variant-options/dto/update-variant-option.dto.js';
import { VariantOptionResponseDto } from '../../variant-options/dto/variant-option-response.dto.js';
import { VariantOptionsService } from '../../variant-options/variant-options.service.js';

/**
 * Administrative variant-option management.
 *
 * Delegates to {@link VariantOptionsService}, so the option-name and option-value
 * normalisation, the case-insensitive uniqueness of a name within one variant, and the
 * 409 that reports it, are one implementation. The axes stay generic name/value pairs —
 * no `colors` or `sizes` table is introduced here, because there is none elsewhere either.
 *
 * The route is the three-segment deep form
 * `products/:productId/variants/:variantId/options`, and that is what the ownership
 * check walks: the product must exist, the variant must belong to it, and the option must
 * belong to that variant. Every step is enforced in the service against the ids **in the
 * path**, so an option reached through the wrong product or the wrong variant is a 404
 * and not a 403 — indistinguishable from an option that does not exist, which is what
 * keeps one variant's options unreadable and unwritable through another's path.
 */
@Controller('admin/products/:productId/variants/:variantId/options')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminVariantOptionsController {
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

  /**
   * Adds an option to a variant of this product.
   *
   * `variantId` is not accepted from the body — the DTO has no such field and the global
   * pipe forbids unknown keys — so an option cannot be filed under a variant the path
   * does not name.
   */
  @Post()
  create(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Body() dto: CreateVariantOptionDto,
  ): Promise<VariantOptionResponseDto> {
    return this.variantOptionsService.create(productId, variantId, dto);
  }

  @Patch(':optionId')
  update(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Param('optionId', ParseUUIDPipe) optionId: string,
    @Body() dto: UpdateVariantOptionDto,
  ): Promise<VariantOptionResponseDto> {
    return this.variantOptionsService.update(productId, variantId, optionId, dto);
  }

  @Delete(':optionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Param('optionId', ParseUUIDPipe) optionId: string,
  ): Promise<void> {
    return this.variantOptionsService.remove(productId, variantId, optionId);
  }
}