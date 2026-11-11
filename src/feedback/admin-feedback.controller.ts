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
  Query,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { Role } from '../generated/prisma/enums.js';
import { AdminListFeedbackQueryDto } from './dto/admin-list-feedback-query.dto.js';
import { AdminFeedbackListResponseDto } from './dto/admin-list-feedback-response.dto.js';
import { AdminCreateFeedbackDto } from './dto/admin-create-feedback.dto.js';
import { AdminUpdateFeedbackDto } from './dto/admin-update-feedback.dto.js';
import { SetFeedbackStatusDto } from './dto/set-feedback-status.dto.js';
import { FeedbackResponseDto } from './dto/feedback-response.dto.js';
import { FeedbackService } from './feedback.service.js';

/**
 * Administrative feedback management.
 *
 * Every route inherits `JwtAuthGuard` then `RolesGuard` with `Role.ADMIN`, so
 * only an administrator may list, create, edit, delete or publish feedback.
 * Authorisation is read from the database row `JwtAuthGuard` loaded, never from
 * the request.
 */
@Controller('admin/feedback')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminFeedbackController {
  constructor(private readonly service: FeedbackService) {}

  /** `GET /admin/feedback` — one page of all feedback, with search and status filter. */
  @Get()
  findAdminPage(
    @Query() query: AdminListFeedbackQueryDto,
  ): Promise<AdminFeedbackListResponseDto> {
    return this.service.findAdminPage(query);
  }

  /** `POST /admin/feedback` — create feedback for an existing customer account. */
  @Post()
  createForAdmin(
    @Body() dto: AdminCreateFeedbackDto,
  ): Promise<FeedbackResponseDto> {
    return this.service.createForAdmin(dto);
  }

  /** `GET /admin/feedback/:id` — one feedback row, with its customer. */
  @Get(':id')
  findAdminById(@Param('id', ParseUUIDPipe) id: string): Promise<FeedbackResponseDto> {
    return this.service.findAdminById(id);
  }

  /** `PATCH /admin/feedback/:id` — edit a feedback row's title and message. */
  @Patch(':id')
  updateAdmin(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminUpdateFeedbackDto,
  ): Promise<FeedbackResponseDto> {
    return this.service.updateAdmin(id, dto);
  }

  /** `DELETE /admin/feedback/:id` — remove a feedback row. */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteAdmin(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.service.deleteAdmin(id);
  }

  /** `PATCH /admin/feedback/:id/status` — publish or unpublish one row. */
  @Patch(':id/status')
  setStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetFeedbackStatusDto,
  ): Promise<FeedbackResponseDto> {
    return this.service.setStatus(id, dto);
  }
}
