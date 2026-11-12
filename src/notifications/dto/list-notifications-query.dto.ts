import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';
import {
  DEFAULT_NOTIFICATION_PAGE_SIZE,
  MAX_NOTIFICATION_PAGE_SIZE,
} from '../constants/notification.constants.js';

/**
 * Pagination for a caller's own notifications.
 *
 * There is deliberately no `userId` filter: ownership comes from the verified
 * session, so a caller cannot ask for anybody else's page by adding a query
 * parameter. Unknown parameters are refused by the global `ValidationPipe`.
 */
export class ListNotificationsQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_NOTIFICATION_PAGE_SIZE)
  limit: number = DEFAULT_NOTIFICATION_PAGE_SIZE;
}
