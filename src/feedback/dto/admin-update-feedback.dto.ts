import { Transform } from 'class-transformer';
import { IsOptional, IsString, IsIn, MinLength, MaxLength } from 'class-validator';
import {
  FEEDBACK_STATUSES,
  TITLE_MAX_LENGTH,
  MESSAGE_MAX_LENGTH,
} from '../constants/feedback-status.constants.js';

/**
 * Input contract for `PATCH /admin/feedback/:id` — an administrator editing a
 * feedback row's title and message.
 */
export class AdminUpdateFeedbackDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'Title must not be empty.' })
  @MaxLength(TITLE_MAX_LENGTH)
  title?: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'Message must not be empty.' })
  @MaxLength(MESSAGE_MAX_LENGTH)
  message?: string;
}
