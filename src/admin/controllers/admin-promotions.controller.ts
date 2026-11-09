import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../auth/guards/roles.guard.js';
import { Role } from '../../generated/prisma/enums.js';
import { PromotionsService } from '../../promotions/promotions.service.js';
import { CreatePromotionDto } from '../../promotions/dto/create-promotion.dto.js';
import { UpdatePromotionDto } from '../../promotions/dto/update-promotion.dto.js';
import { PromotionListQueryDto } from '../../promotions/dto/promotion-list-query.dto.js';
import { PromotionUsageListQueryDto } from '../../promotions/dto/promotion-usage-list-query.dto.js';
import { PromotionResponseDto } from '../../promotions/dto/promotion-response.dto.js';
import { PromotionListResponseDto } from '../../promotions/dto/promotion-list-response.dto.js';
import { PromotionUsageListResponseDto } from '../../promotions/dto/promotion-usage-list-response.dto.js';

/** Administrative transport layer for the existing promotion domain service. */
@Controller('admin/promotions')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminPromotionsController {
  constructor(private readonly promotionsService: PromotionsService) {}

  @Get()
  list(@Query() query: PromotionListQueryDto): Promise<PromotionListResponseDto> {
    return this.promotionsService.list(query);
  }

  @Post()
  create(@Body() dto: CreatePromotionDto): Promise<PromotionResponseDto> {
    return this.promotionsService.create(dto);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<PromotionResponseDto> {
    return this.promotionsService.findById(id);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePromotionDto,
  ): Promise<PromotionResponseDto> {
    return this.promotionsService.update(id, dto);
  }

  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  activate(@Param('id', ParseUUIDPipe) id: string): Promise<PromotionResponseDto> {
    return this.promotionsService.activate(id);
  }

  @Post(':id/pause')
  @HttpCode(HttpStatus.OK)
  pause(@Param('id', ParseUUIDPipe) id: string): Promise<PromotionResponseDto> {
    return this.promotionsService.pause(id);
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  archive(@Param('id', ParseUUIDPipe) id: string): Promise<PromotionResponseDto> {
    return this.promotionsService.archive(id);
  }

  @Get(':id/usages')
  usages(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: PromotionUsageListQueryDto,
  ): Promise<PromotionUsageListResponseDto> {
    return this.promotionsService.listUsages(id, query);
  }
}
