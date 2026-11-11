import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  DEFAULT_FEEDBACK_PAGE_SIZE,
  FEEDBACK_PAGE_SIZES,
  FEEDBACK_STATUSES,
} from '../constants/feedback-status.constants.js';

/**
 * Filters the administrator may apply to the feedback listing.
 *
 * Unknown parameters are refused by the global `ValidationPipe` rather than
 * silently ignored, so a mistyped filter cannot be mistaken for an empty result.
 */
export class AdminListFeedbackQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(FEEDBACK_PAGE_SIZES[FEEDBACK_PAGE_SIZES.length - 1] ?? 100)
  limit: number = DEFAULT_FEEDBACK_PAGE_SIZE;

  /** Matched, case-insensitively, inside title, message and customer identity. */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @IsOptional()
  @IsIn(FEEDBACK_STATUSES)
  status?: (typeof FEEDBACK_STATUSES)[number];

  @IsOptional()
  @IsIn(['createdAt'])
  sortBy?: 'createdAt';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc';
}
