import { Injectable } from '@nestjs/common';
import { Prisma, type Feedback } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AdminListFeedbackQueryDto } from './dto/admin-list-feedback-query.dto.js';
import { FEEDBACK_STATUS_PUBLISHED } from './constants/feedback-status.constants.js';

export interface FeedbackCustomerPage {
  items: Feedback[];
  total: number;
}

export interface FeedbackAdminPage {
  items: Array<
    Feedback & {
      customer: { firstName: string; lastName: string; email: string };
    }
  >;
  total: number;
}

const PUBLIC_FEEDBACK_SELECT = {
  id: true,
  title: true,
  message: true,
  createdAt: true,
  customer: { select: { firstName: true, lastName: true } },
} satisfies Prisma.FeedbackSelect;

export type PublicFeedbackRow = Prisma.FeedbackGetPayload<{
  select: typeof PUBLIC_FEEDBACK_SELECT;
}>;

export interface FeedbackPublicPage {
  items: PublicFeedbackRow[];
  total: number;
}

/**
 * The only place in the feedback feature that talks to the database.
 *
 * ## Ownership
 *
 * Customer-scoped reads always constrain by `customerId`, so a customer can
 * never reach another customer's row through this repository.
 *
 * ## Publication
 *
 * `UNPUBLISHED` rows are excluded from the public listing at the query level,
 * so the public endpoint cannot leak them even if a caller bypasses the service.
 */
@Injectable()
export class FeedbackRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Creates one feedback row. The caller supplies the owning customer id. */
  create(
    data: Prisma.FeedbackCreateInput,
  ): Promise<Feedback> {
    return this.prisma.feedback.create({ data });
  }

  /** Returns one row by id, or `null`. */
  findById(id: string): Promise<Feedback | null> {
    return this.prisma.feedback.findUnique({ where: { id } });
  }

  /** Returns one row only when it belongs to `customerId`, or `null`. */
  findByIdAndCustomer(id: string, customerId: string): Promise<Feedback | null> {
    return this.prisma.feedback.findUnique({ where: { id, customerId } });
  }

  /** Returns one page of `customerId`'s feedback, newest first. */
  async findCustomerPage(
    customerId: string,
    page: number,
    limit: number,
  ): Promise<FeedbackCustomerPage> {
    const skip = (page - 1) * limit;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.feedback.findMany({
        where: { customerId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.feedback.count({ where: { customerId } }),
    ]);

    return { items, total };
  }

  /** Returns one page of all feedback, newest first, with the owning customer. */
  async findAdminPage(
    query: AdminListFeedbackQueryDto,
  ): Promise<FeedbackAdminPage> {
    const { page, limit, search, status } = query;
    const skip = (page - 1) * limit;

    const where: Prisma.FeedbackWhereInput = {};
    if (status !== undefined) where.status = status;

    if (search !== undefined && search.length > 0) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { message: { contains: search, mode: 'insensitive' } },
        {
          customer: { firstName: { contains: search, mode: 'insensitive' } },
        },
        {
          customer: { lastName: { contains: search, mode: 'insensitive' } },
        },
        { customer: { email: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.feedback.findMany({
        where,
        include: {
          customer: { select: { firstName: true, lastName: true, email: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.feedback.count({ where }),
    ]);

    return { items, total };
  }

  /** Updates `title` and/or `message` on one row. */
  async update(
    id: string,
    data: Prisma.FeedbackUpdateInput,
  ): Promise<Feedback> {
    return this.prisma.feedback.update({ where: { id }, data });
  }

  /** Sets one row's publication status. */
  async setStatus(id: string, status: string): Promise<Feedback> {
    return this.prisma.feedback.update({ where: { id }, data: { status } });
  }

  /** Deletes one row. */
  async delete(id: string): Promise<void> {
    await this.prisma.feedback.delete({ where: { id } });
  }

  /** Returns one page of published feedback, newest first, for the public site. */
  async findPublishedPage(
    page: number,
    limit: number,
  ): Promise<FeedbackPublicPage> {
    const skip = (page - 1) * limit;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.feedback.findMany({
        where: { status: FEEDBACK_STATUS_PUBLISHED },
        select: PUBLIC_FEEDBACK_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.feedback.count({ where: { status: FEEDBACK_STATUS_PUBLISHED } }),
    ]);

    return { items, total };
  }
}
