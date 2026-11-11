import type { Feedback } from '../../generated/prisma/client.js';

/**
 * Outbound representation of one feedback row.
 *
 * The customer id is included so the client can scope ownership; the customer's
 * name is deliberately absent here — customer-scoped responses already know who
 * owns the row, and admin responses map their own customer summary instead.
 */
export class FeedbackResponseDto {
  id: string;
  customerId: string;
  title: string;
  message: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;

  static fromEntity(feedback: Feedback): FeedbackResponseDto {
    const dto = new FeedbackResponseDto();

    dto.id = feedback.id;
    dto.customerId = feedback.customerId;
    dto.title = feedback.title;
    dto.message = feedback.message;
    dto.status = feedback.status;
    dto.createdAt = feedback.createdAt;
    dto.updatedAt = feedback.updatedAt;

    return dto;
  }
}
