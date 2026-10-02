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
import { CreateVariantOptionDto } from './dto/create-variant-option.dto.js';
import { UpdateVariantOptionDto } from './dto/update-variant-option.dto.js';
import { VariantOptionResponseDto } from './dto/variant-option-response.dto.js';
import { VariantOptionsService } from './variant-options.service.js';

/**
 * HTTP routing only: parse the request through the pipes and DTOs, delegate to
 * `VariantOptionsService`, return its result. No business rules and no database
 * access live here.
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

  @Post()
  create(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Body() dto: CreateVariantOptionDto,
  ): Promise<VariantOptionResponseDto> {
    return this.variantOptionsService.create(productId, variantId, dto);
  }

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

  @Patch(':optionId')
  update(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Param('optionId', ParseUUIDPipe) optionId: string,
    @Body() dto: UpdateVariantOptionDto,
  ): Promise<VariantOptionResponseDto> {
    return this.variantOptionsService.update(
      productId,
      variantId,
      optionId,
      dto,
    );
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
