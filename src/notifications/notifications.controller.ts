import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.js';
import { ListNotificationsQueryDto } from './dto/list-notifications-query.dto.js';
import type { NotificationListResponse } from './dto/notification-response.dto.js';
import type { NotificationView } from './dto/notification-response.dto.js';
import { NotificationsService } from './notifications.service.js';

/**
 * HTTP routing for the in-app notification center, shared by both audiences.
 *
 * ## One controller, scoped by identity
 *
 * There is deliberately no `/admin/notifications` twin. A notification is addressed
 * to exactly one user, and the caller's identity — resolved by `JwtAuthGuard` from a
 * verified token — is the only thing that decides which rows are reachable. An
 * administrator simply happens to own the `ADMIN_*` rows; a customer owns the order
 * rows. Adding a role-specific route would duplicate the same five operations and
 * create a second place for the ownership rule to be forgotten.
 *
 * ## Why there is no `userId` parameter anywhere
 *
 * The list query refuses unknown parameters (the global `ValidationPipe` runs with
 * `forbidNonWhitelisted`), and the service scopes every read and write to
 * `user.id`. A caller therefore cannot ask for somebody else's page, mark somebody
 * else's row read, or delete a row they do not own — "not yours" and "does not
 * exist" are the same 404.
 */
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  /** `GET /notifications` — one page of the caller's notifications, newest first. */
  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListNotificationsQueryDto,
  ): Promise<NotificationListResponse> {
    return this.notificationsService.list(user.id, query);
  }

  /**
   * `GET /notifications/unread-count` — the badge number for the bell.
   *
   * A dedicated route rather than a field on the list response: the header polls
   * the count far more often than it opens the list, and counting is a single
   * indexed `COUNT` that does not have to load a page of rows to answer.
   */
  @Get('unread-count')
  unreadCount(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ count: number }> {
    return this.notificationsService.unreadCount(user.id);
  }

  /**
   * `PATCH /notifications/read-all` — mark every unread notification read.
   *
   * Declared before the `:id` routes so the literal path is never captured as an
   * identifier; it also carries no body, so there is nothing to validate.
   */
  @Patch('read-all')
  @HttpCode(HttpStatus.OK)
  markAllRead(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ updated: number }> {
    return this.notificationsService.markAllRead(user.id);
  }

  /**
   * `PATCH /notifications/:id/read` — mark one notification read.
   *
   * `:id` runs through `ParseUUIDPipe`, so a malformed identifier is a 400 before
   * the service is reached. Idempotent: an already-read row is returned unchanged.
   */
  @Patch(':id/read')
  @HttpCode(HttpStatus.OK)
  markRead(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<NotificationView> {
    return this.notificationsService.markRead(user.id, id);
  }

  /**
   * `DELETE /notifications/:id` — remove one notification the caller owns.
   *
   * Returns `204 No Content`. A row that is absent or owned by somebody else is a
   * 404, so deletion cannot be used to discover whether an id exists.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.notificationsService.remove(user.id, id);
  }
}
