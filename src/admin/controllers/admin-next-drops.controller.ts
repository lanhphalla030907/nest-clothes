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
import { NextDropService } from '../../next-drops/next-drops.service.js';
import { CreateNextDropDto, UpdateNextDropDto } from '../../next-drops/next-drops.dto.js';

/**
 * Administrative management of next drops.
 *
 * Every handler is behind `JwtAuthGuard` and `RolesGuard(Role.ADMIN)`. The
 * single-published rule is enforced by the service inside a transaction and by
 * a database partial unique index, so two published drops can never coexist.
 */
@Controller('admin/next-drops')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class NextDropAdminController {
  constructor(private readonly nextDropService: NextDropService) {}

  @Get()
  findAll() {
    return this.nextDropService.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.nextDropService.findById(id);
  }

  @Post()
  create(@Body() dto: CreateNextDropDto) {
    return this.nextDropService.create(dto);
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateNextDropDto) {
    return this.nextDropService.update(id, dto);
  }

  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  publish(@Param('id', ParseUUIDPipe) id: string) {
    return this.nextDropService.publish(id);
  }

  @Post(':id/unpublish')
  @HttpCode(HttpStatus.OK)
  unpublish(@Param('id', ParseUUIDPipe) id: string) {
    return this.nextDropService.unpublish(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.nextDropService.remove(id);
  }
}
