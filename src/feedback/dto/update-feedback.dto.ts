import { Transform } from 'class-transformer';
import { IsOptional, IsString, MinLength, MaxLength } from 'class-validator';
import { TITLE_MAX_LENGTH, MESSAGE_MAX_LENGTH } from '../constants/feedback-status.constants.js';

/**
 * Input contract for `PATCH /feedback/:id` (a customer editing their own feedback).
 *
 * Only `title` and `message` can change: a customer can never publish or
 * unpublish their own feedback, and absent fields are left untouched.
 */
export class UpdateFeedbackDto {
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
