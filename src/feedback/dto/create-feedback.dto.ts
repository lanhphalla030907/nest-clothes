import { Transform } from 'class-transformer';
import { IsString, MinLength, MaxLength } from 'class-validator';
import { TITLE_MAX_LENGTH, MESSAGE_MAX_LENGTH } from '../constants/feedback-status.constants.js';

/**
 * Input contract for `POST /feedback` (a customer's own feedback).
 *
 * `customerId`, `status`, `id`, `createdAt` and `updatedAt` are intentionally
 * absent: the service derives the customer from the authenticated session and
 * owns the lifecycle, so a client can never submit feedback on another account's
 * behalf or pre-set its publication status.
 */
export class CreateFeedbackDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1, { message: 'Title is required.' })
  @MaxLength(TITLE_MAX_LENGTH)
  title: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1, { message: 'Message is required.' })
  @MaxLength(MESSAGE_MAX_LENGTH)
  message: string;
}
