import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../auth/guards/roles.guard.js';
import { CodAreasService } from '../../cod-areas/cod-areas.service.js';
import { CreateCodAreaDto } from '../../cod-areas/dto/create-cod-area.dto.js';
import { CodAreaResponseDto } from '../../cod-areas/dto/cod-area-response.dto.js';
import { UpdateCodAreaDto } from '../../cod-areas/dto/update-cod-area.dto.js';
import { Role } from '../../generated/prisma/enums.js';

@Controller('admin/cod-areas')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminCodAreasController {
  constructor(private readonly codAreasService: CodAreasService) {}

  @Get()
  findAll(): Promise<CodAreaResponseDto[]> {
    return this.codAreasService.listForAdmin();
  }

  @Post()
  create(@Body() dto: CreateCodAreaDto): Promise<CodAreaResponseDto> {
    return this.codAreasService.create(dto);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCodAreaDto,
  ): Promise<CodAreaResponseDto> {
    return this.codAreasService.update(id, dto);
  }
}
