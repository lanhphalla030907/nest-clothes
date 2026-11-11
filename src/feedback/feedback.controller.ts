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
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.js';
import { CreateFeedbackDto } from './dto/create-feedback.dto.js';
import { UpdateFeedbackDto } from './dto/update-feedback.dto.js';
import { FeedbackResponseDto } from './dto/feedback-response.dto.js';
import { AdminListFeedbackQueryDto } from './dto/admin-list-feedback-query.dto.js';
import { FeedbackService } from './feedback.service.js';

/**
 * A customer's own feedback.
 *
 * Every route inherits `JwtAuthGuard`. The customer id is always taken from the
 * verified session through `CurrentUser`, never from the request, so a caller
 * can only ever create, read, update or delete their own feedback.
 *
 * Routes are declared with the static segments first (`GET /feedback` before
 * `GET /feedback/:id`) so Nest never mistakes `feedback` for an id.
 */
@Controller('feedback')
@UseGuards(JwtAuthGuard)
export class FeedbackController {
  constructor(private readonly service: FeedbackService) {}

  /**
   * `POST /feedback` — create the caller's own feedback.
   *
   * Left `UNPUBLISHED` until an administrator publishes it.
   */
  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateFeedbackDto,
  ): Promise<FeedbackResponseDto> {
    return this.service.createForCustomer(user.id, dto);
  }

  /**
   * `GET /feedback` — one page of the caller's own feedback, newest first.
   */
  @Get()
  findCustomerPage(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: AdminListFeedbackQueryDto,
  ) {
    return this.service.findCustomerPage(user.id, query);
  }

  /**
   * `GET /feedback/:id` — one of the caller's own feedback rows.
   */
  @Get(':id')
  findCustomerById(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<FeedbackResponseDto> {
    return this.service.findCustomerById(id, user.id);
  }

  /**
   * `PATCH /feedback/:id` — edit the caller's own feedback.
   */
  @Patch(':id')
  updateForCustomer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateFeedbackDto,
  ): Promise<FeedbackResponseDto> {
    return this.service.updateForCustomer(id, user.id, dto);
  }

  /**
   * `DELETE /feedback/:id` — remove the caller's own feedback.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteForCustomer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.service.deleteForCustomer(id, user.id);
  }
}
