import type { Notification } from '../../generated/prisma/client.js';

/** The fields of a notification a client may see. */
export interface NotificationView {
  id: string;
  userId: string;
  type: string;
  title: string;
  message: string;
  data: unknown;
  readAt: Date | null;
  createdAt: Date;
}

export interface NotificationPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface NotificationListResponse {
  items: NotificationView[];
  pagination: NotificationPagination;
}

/**
 * Maps a stored row to the response shape.
 *
 * `dedupeKey` is intentionally absent: it is the internal idempotency guard,
 * not part of the client contract.
 */
export const toNotificationView = (
  notification: Omit<Notification, 'dedupeKey'>,
): NotificationView => ({
  id: notification.id,
  userId: notification.userId,
  type: notification.type,
  title: notification.title,
  message: notification.message,
  data: notification.data,
  readAt: notification.readAt,
  createdAt: notification.createdAt,
});

export class NotificationListResponseDto {
  static fromRows(
    rows: Array<Omit<Notification, 'dedupeKey'>>,
    page: number,
    limit: number,
    total: number,
  ): NotificationListResponse {
    return {
      items: rows.map(toNotificationView),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }
}
