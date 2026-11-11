import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '../generated/prisma/enums.js';
import { ACTIVE_USER_STATUS } from '../common/constants/user-status.constants.js';
import { FEEDBACK_STATUS_UNPUBLISHED } from './constants/feedback-status.constants.js';
import { FeedbackRepository } from './feedback.repository.js';
import { UsersRepository } from '../users/repositories/users.repository.js';
import { FeedbackResponseDto } from './dto/feedback-response.dto.js';
import { AdminFeedbackListResponseDto } from './dto/admin-list-feedback-response.dto.js';
import type { CreateFeedbackDto } from './dto/create-feedback.dto.js';
import type { UpdateFeedbackDto } from './dto/update-feedback.dto.js';
import type { AdminListFeedbackQueryDto } from './dto/admin-list-feedback-query.dto.js';
import type { AdminCreateFeedbackDto } from './dto/admin-create-feedback.dto.js';
import type { AdminUpdateFeedbackDto } from './dto/admin-update-feedback.dto.js';
import type { SetFeedbackStatusDto } from './dto/set-feedback-status.dto.js';

const FEEDBACK_NOT_FOUND = 'Feedback does not exist';
const NOT_A_CUSTOMER = 'Feedback can only be created for a customer account.';

/**
 * Feedback write and read logic.
 *
 * ## Customer ownership
 *
 * The customer id always comes from the authenticated session (`CurrentUser`),
 * never from the request body or params. A customer-scoped method can only ever
 * touch its own caller's rows.
 *
 * ## Administration
 *
 * Admin-created feedback references an existing `CUSTOMER` account, resolved
 * through `UsersRepository`. No account is created here.
 */
@Injectable()
export class FeedbackService {
  constructor(
    private readonly repository: FeedbackRepository,
    private readonly usersRepository: UsersRepository,
  ) {}

  /** Creates feedback for the authenticated customer, left unpublished. */
  async createForCustomer(
    customerId: string,
    dto: CreateFeedbackDto,
  ): Promise<FeedbackResponseDto> {
    const feedback = await this.repository.create({
      customer: { connect: { id: customerId } },
      title: dto.title,
      message: dto.message,
      status: FEEDBACK_STATUS_UNPUBLISHED,
    });

    return FeedbackResponseDto.fromEntity(feedback);
  }

  /** Returns one page of the authenticated customer's feedback. */
  async findCustomerPage(
    customerId: string,
    query: AdminListFeedbackQueryDto,
  ): Promise<{
    items: FeedbackResponseDto[];
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const { items, total } = await this.repository.findCustomerPage(
      customerId,
      page,
      limit,
    );

    return {
      items: items.map((feedback) => FeedbackResponseDto.fromEntity(feedback)),
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    };
  }

  /** Returns one of the authenticated customer's feedback rows, or 404. */
  async findCustomerById(
    id: string,
    customerId: string,
  ): Promise<FeedbackResponseDto> {
    const feedback = await this.repository.findByIdAndCustomer(id, customerId);

    if (feedback === null) {
      throw new NotFoundException(FEEDBACK_NOT_FOUND);
    }

    return FeedbackResponseDto.fromEntity(feedback);
  }

  /** Replaces `title` and/or `message` on one of the customer's own rows. */
  async updateForCustomer(
    id: string,
    customerId: string,
    dto: UpdateFeedbackDto,
  ): Promise<FeedbackResponseDto> {
    const feedback = await this.repository.findByIdAndCustomer(id, customerId);

    if (feedback === null) {
      throw new NotFoundException(FEEDBACK_NOT_FOUND);
    }

    const data: Record<string, unknown> = {};
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.message !== undefined) data.message = dto.message;

    const updated = await this.repository.update(id, data);

    return FeedbackResponseDto.fromEntity(updated);
  }

  /** Deletes one of the customer's own feedback rows. */
  async deleteForCustomer(id: string, customerId: string): Promise<void> {
    const feedback = await this.repository.findByIdAndCustomer(id, customerId);

    if (feedback === null) {
      throw new NotFoundException(FEEDBACK_NOT_FOUND);
    }

    await this.repository.delete(id);
  }

  /** Returns one page of all feedback for the administration listing. */
  async findAdminPage(query: AdminListFeedbackQueryDto) {
    const { items, total } = await this.repository.findAdminPage(query);

    return AdminFeedbackListResponseDto.fromRows(
      items,
      query.page ?? 1,
      query.limit ?? 20,
      total,
    );
  }

  /**
   * Creates feedback on behalf of an existing customer.
   *
   * `customerId` must name a real `CUSTOMER` account — any other role, or no
   * account at all, is refused. No account is created here.
   */
  async createForAdmin(dto: AdminCreateFeedbackDto): Promise<FeedbackResponseDto> {
    const customer = await this.usersRepository.findById(dto.customerId);

    if (customer === null) {
      throw new NotFoundException(`Customer ${dto.customerId} does not exist`);
    }

    if (customer.role !== Role.CUSTOMER) {
      throw new BadRequestException(NOT_A_CUSTOMER);
    }

    const feedback = await this.repository.create({
      customer: { connect: { id: customer.id } },
      title: dto.title,
      message: dto.message,
      status: FEEDBACK_STATUS_UNPUBLISHED,
    });

    return FeedbackResponseDto.fromEntity(feedback);
  }

  /** Returns one feedback row for the administration detail view, or 404. */
  async findAdminById(id: string): Promise<FeedbackResponseDto> {
    const feedback = await this.repository.findById(id);

    if (feedback === null) {
      throw new NotFoundException(FEEDBACK_NOT_FOUND);
    }

    return FeedbackResponseDto.fromEntity(feedback);
  }

  /** Replaces `title` and/or `message` on one feedback row. */
  async updateAdmin(
    id: string,
    dto: AdminUpdateFeedbackDto,
  ): Promise<FeedbackResponseDto> {
    const feedback = await this.repository.findById(id);

    if (feedback === null) {
      throw new NotFoundException(FEEDBACK_NOT_FOUND);
    }

    const data: Record<string, unknown> = {};
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.message !== undefined) data.message = dto.message;

    const updated = await this.repository.update(id, data);

    return FeedbackResponseDto.fromEntity(updated);
  }

  /** Deletes one feedback row. */
  async deleteAdmin(id: string): Promise<void> {
    const feedback = await this.repository.findById(id);

    if (feedback === null) {
      throw new NotFoundException(FEEDBACK_NOT_FOUND);
    }

    await this.repository.delete(id);
  }

  /** Publishes or unpublishes one feedback row. */
  async setStatus(
    id: string,
    dto: SetFeedbackStatusDto,
  ): Promise<FeedbackResponseDto> {
    const feedback = await this.repository.findById(id);

    if (feedback === null) {
      throw new NotFoundException(FEEDBACK_NOT_FOUND);
    }

    const updated = await this.repository.setStatus(id, dto.status);

    return FeedbackResponseDto.fromEntity(updated);
  }

  /** Returns one page of published feedback for the public website. */
  async findPublishedPage(query: AdminListFeedbackQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const { items, total } = await this.repository.findPublishedPage(
      page,
      limit,
    );

    return {
      items: items.map((item) => ({
        id: item.id,
        customerName: `${item.customer.firstName} ${item.customer.lastName}`
          .trim() || '',
        title: item.title,
        message: item.message,
        createdAt: item.createdAt,
      })),
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    };
  }
}
