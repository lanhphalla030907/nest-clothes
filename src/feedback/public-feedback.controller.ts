import { Controller, Get, Query } from '@nestjs/common';
import { AdminListFeedbackQueryDto } from './dto/admin-list-feedback-query.dto.js';
import { FeedbackService } from './feedback.service.js';

/**
 * Public feedback: published rows only, with pagination.
 *
 * No guard: the storefront is open to every visitor, and unpublished rows are
 * excluded at the repository level so they can never leak through this endpoint.
 */
@Controller('feedback/public')
export class PublicFeedbackController {
  constructor(private readonly service: FeedbackService) {}

  /** `GET /feedback/public` — one page of published feedback, newest first. */
  @Get()
  findPublished(@Query() query: AdminListFeedbackQueryDto) {
    return this.service.findPublishedPage(query);
  }
}
