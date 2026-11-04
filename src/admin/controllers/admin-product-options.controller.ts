import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../auth/guards/roles.guard.js';
import { Role } from '../../generated/prisma/enums.js';
import { PreviewProductOptionsDto } from '../../product-options/dto/product-option-draft.dto.js';
import { SaveProductOptionsDto } from '../../product-options/dto/save-product-options.dto.js';
import { ProductOptionsService } from '../../product-options/product-options.service.js';

@Controller('admin/products/:productId/options')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminProductOptionsController {
  constructor(private readonly productOptionsService: ProductOptionsService) {}

  @Get()
  findByProductId(
    @Param('productId', ParseUUIDPipe) productId: string,
  ) {
    return this.productOptionsService.findByProductId(productId);
  }

  @Post('preview')
  @HttpCode(HttpStatus.OK)
  preview(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: PreviewProductOptionsDto,
  ) {
    return this.productOptionsService.preview(productId, dto);
  }

  @Put()
  save(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: SaveProductOptionsDto,
  ) {
    return this.productOptionsService.save(productId, dto);
  }
}
