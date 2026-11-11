import { IsIn } from 'class-validator';
import { FEEDBACK_STATUSES } from '../constants/feedback-status.constants.js';

/**
 * Input contract for `PATCH /admin/feedback/:id/status` — publishing or
 * unpublishing one feedback row.
 */
export class SetFeedbackStatusDto {
  @IsIn(FEEDBACK_STATUSES)
  status: (typeof FEEDBACK_STATUSES)[number];
}
