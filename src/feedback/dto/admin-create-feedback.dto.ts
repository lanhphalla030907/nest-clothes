import { Transform } from 'class-transformer';
import { IsString, IsUUID, MinLength, MaxLength } from 'class-validator';
import { TITLE_MAX_LENGTH, MESSAGE_MAX_LENGTH } from '../constants/feedback-status.constants.js';

/**
 * Input contract for `POST /admin/feedback` — creating feedback on behalf of a
 * customer.
 *
 * `customerId` is the only customer reference the client may supply, and the
 * service refuses it unless it names an existing `CUSTOMER` account: no fake
 * accounts are created and no other role may be chosen.
 */
export class AdminCreateFeedbackDto {
  @IsUUID()
  customerId: string;

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
