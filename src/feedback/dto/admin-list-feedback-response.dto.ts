import type { Feedback } from '../../generated/prisma/client.js';

/** One row of the administrative feedback listing, with the owning customer. */
export interface AdminFeedbackSummary {
  id: string;
  customerId: string;
  customerName: string;
  customerEmail: string;
  title: string;
  message: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Pagination metadata beside the feedback listing page. */
export interface AdminFeedbackPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/** The administrative feedback listing. */
export interface AdminFeedbackListResponse {
  items: AdminFeedbackSummary[];
  pagination: AdminFeedbackPagination;
}

/** Builds the response from repository rows. */
export class AdminFeedbackListResponseDto {
  static fromRows(
    rows: Array<Feedback & { customer: { firstName: string; lastName: string; email: string } }>,
    page: number,
    limit: number,
    total: number,
  ): AdminFeedbackListResponse {
    const items = rows.map((feedback) => ({
      id: feedback.id,
      customerId: feedback.customerId,
      customerName: `${feedback.customer.firstName} ${feedback.customer.lastName}`.trim() ||
        feedback.customer.email,
      customerEmail: feedback.customer.email,
      title: feedback.title,
      message: feedback.message,
      status: feedback.status,
      createdAt: feedback.createdAt,
      updatedAt: feedback.updatedAt,
    }));

    return {
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }
}
