import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CloudinaryService } from '../cloudinary/cloudinary.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { DeliveryRepository } from './repositories/delivery.repository.js';
import { AssignDeliveryDto } from './dto/assign-delivery.dto.js';
import { CollectCodDto } from './dto/collect-cod.dto.js';
import { ReassignDeliveryDto } from './dto/reassign-delivery.dto.js';
import { UpdateDeliveryStatusDto } from './dto/update-delivery-status.dto.js';
import { DeliveryQueryDto } from './dto/delivery-query.dto.js';
import type { UploadedReceiptFile } from './interfaces/uploaded-receipt-file.js';
import { DeliveryStatus, Role } from '../generated/prisma/enums.js';
import { ACTIVE_USER_STATUS } from '../common/constants/user-status.constants.js';
import {
  DELIVERY_MANAGER_ROLES,
  DELIVERY_STAFF_ROLES,
} from './constants/delivery-authorization.constants.js';
import { ELIGIBLE_ORDER_STATUSES_FOR_ASSIGNMENT, isValidDeliveryTransition } from './constants/delivery-status.constants.js';

@Injectable()
export class DeliveryService {
  private readonly logger = new Logger(DeliveryService.name);

  constructor(
    private readonly deliveryRepo: DeliveryRepository,
    private readonly cloudinaryService: CloudinaryService,
  ) {}

  /**
   * Re-reads the acting user from the database and requires an active account
   * holding one of the roles allowed for the operation.
   *
   * Controllers mount `JwtAuthGuard` and `RolesGuard`, so this is the
   * service-level backstop for callers that bypass HTTP. Both role and status
   * come from the user row, never from the request body or token claims, so a
   * suspended manager or staff member is refused here as well as at the guard.
   */
  private async requireActiveRole(
    userId: string,
    allowedRoles: readonly Role[],
    forbiddenMessage: string,
  ): Promise<void> {
    const user = await this.deliveryRepo.findUserById(userId);

    if (
      !user ||
      user.status !== ACTIVE_USER_STATUS ||
      !allowedRoles.includes(user.role)
    ) {
      throw new ForbiddenException(forbiddenMessage);
    }
  }

  async listDeliveryOrders(query: DeliveryQueryDto) {
    const result = await this.deliveryRepo.findAllDeliveryOrders({
      status: query.status,
      deliveryStaffId: query.deliveryStaffId,
      search: query.search,
      page: query.page,
      limit: query.limit,
    });
    return {
      items: result.items,
      pagination: {
        page: result.page,
        limit: result.limit,
        total: result.total,
        totalPages: result.totalPages,
      },
    };
  }

  async getOrderDeliveryDetails(orderId: string) {
    const order = await this.deliveryRepo.findOrderById(orderId);
    if (!order) {
      throw new NotFoundException('Order not found');
    }
    return order;
  }

  async assignDelivery(assignedById: string, dto: AssignDeliveryDto) {
    await this.requireActiveRole(
      assignedById,
      DELIVERY_MANAGER_ROLES,
      'Only active delivery managers or admins can assign orders',
    );

    try {
      return await this.deliveryRepo.runInTransaction(async (tx) => {
        const orderRows = await (tx as any).$queryRaw`
          SELECT * FROM "orders" WHERE "id" = ${dto.orderId}::uuid FOR UPDATE
        `;
        const order = orderRows[0];
        if (!order) {
          throw new NotFoundException('Order not found');
        }

        if (!ELIGIBLE_ORDER_STATUSES_FOR_ASSIGNMENT.includes(order.status)) {
          throw new BadRequestException('Order is not eligible for delivery assignment');
        }

        if (order.status === 'CANCELLED') {
          throw new BadRequestException('Cannot assign cancelled order');
        }

        const staff = await this.deliveryRepo.findUserById(dto.deliveryStaffId, tx);
        if (!staff) {
          throw new NotFoundException('Delivery staff not found');
        }
        if (staff.role !== Role.DELIVERY_STAFF) {
          throw new BadRequestException('Only delivery staff can be assigned');
        }
        if (staff.status !== ACTIVE_USER_STATUS) {
          throw new BadRequestException('Inactive staff cannot receive assignments');
        }

        const existingActive = await (tx as any).deliveryAssignment.findFirst({
          where: { orderId: dto.orderId },
          orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
        });
        if (existingActive) {
          if (existingActive.status === 'DELIVERED' || existingActive.status === 'RETURNED') {
            if (!existingActive.endedAt) {
              await (tx as any).deliveryAssignment.update({
                where: { id: existingActive.id },
                data: { endedAt: new Date() },
              });
            }
          } else {
            throw new ConflictException('Order already has an active assignment');
          }
        }

        const assignment = await this.deliveryRepo.createAssignment(
          {
            orderId: dto.orderId,
            deliveryStaffId: dto.deliveryStaffId,
            assignedById,
            status: 'ASSIGNED',
          },
          tx,
        );
        return assignment;
      });
    } catch (error: any) {
      // Handle PostgreSQL unique constraint violation from partial unique index
      if (error.code === 'P2002' || error.code === '23505') {
        throw new ConflictException('Order already has an active assignment');
      }
      throw error;
    }
  }

  async reassignDelivery(assignedById: string, orderId: string, dto: ReassignDeliveryDto) {
    await this.requireActiveRole(
      assignedById,
      DELIVERY_MANAGER_ROLES,
      'Only active delivery managers or admins can reassign orders',
    );

    try {
      return await this.deliveryRepo.runInTransaction(async (tx: any) => {
        const orderRows = await tx.$queryRaw`
          SELECT * FROM "orders" WHERE "id" = ${orderId}::uuid FOR UPDATE
        `;
        const order = orderRows[0];
        if (!order) {
          throw new NotFoundException('Order not found');
        }

        if (!ELIGIBLE_ORDER_STATUSES_FOR_ASSIGNMENT.includes(order.status)) {
          throw new BadRequestException('Order is not eligible for delivery assignment');
        }

        if (order.status === 'CANCELLED') {
          throw new BadRequestException('Cannot assign cancelled order');
        }

        const staff = await this.deliveryRepo.findUserById(dto.deliveryStaffId, tx);
        if (!staff) {
          throw new NotFoundException('Delivery staff not found');
        }
        if (staff.role !== Role.DELIVERY_STAFF) {
          throw new BadRequestException('Only delivery staff can be assigned');
        }
        if (staff.status !== ACTIVE_USER_STATUS) {
          throw new BadRequestException('Inactive staff cannot receive assignments');
        }

        const currentActive = await tx.deliveryAssignment.findFirst({
          where: { orderId },
          orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
        });

        if (currentActive) {
          if (currentActive.status === 'DELIVERED') {
            throw new BadRequestException('Cannot reassign a completed order');
          }
          if (currentActive.status === 'RETURNED') {
            throw new BadRequestException('Cannot reassign a returned order');
          }
          if (currentActive.status === 'OUT_FOR_DELIVERY') {
            throw new BadRequestException('Cannot reassign order that is out for delivery');
          }
          if (currentActive.status === 'FAILED_DELIVERY') {
            // Policy: Allow reassignment on FAILED_DELIVERY - close previous and create new
            if (!currentActive.endedAt) {
              await tx.deliveryAssignment.update({
                where: { id: currentActive.id },
                data: { endedAt: new Date() },
              });
            }
          } else if (currentActive.status === 'ASSIGNED' || currentActive.status === 'PENDING_ASSIGNMENT') {
            // Can reassign from ASSIGNED or PENDING_ASSIGNMENT
            if (!currentActive.endedAt) {
              await tx.deliveryAssignment.update({
                where: { id: currentActive.id },
                data: { endedAt: new Date() },
              });
            }
          } else {
            throw new ConflictException('Order already has an active assignment');
          }
        }

        const assignment = await this.deliveryRepo.createAssignment(
          {
            orderId,
            deliveryStaffId: dto.deliveryStaffId,
            assignedById,
            status: 'ASSIGNED',
          },
          tx,
        );
        return assignment;
      });
    } catch (error: any) {
      if (error.code === 'P2002' || error.code === '23505') {
        throw new ConflictException('Order already has an active assignment');
      }
      throw error;
    }
  }

  async getMyAssignments(staffId: string, query: DeliveryQueryDto) {
    await this.requireActiveRole(
      staffId,
      DELIVERY_STAFF_ROLES,
      'Only active delivery staff can access their assignments',
    );

    const result = await this.deliveryRepo.findAssignmentsForStaff(staffId, {
      status: query.status,
      page: query.page,
      limit: query.limit,
    });
    return {
      items: result.items,
      pagination: {
        page: result.page,
        limit: result.limit,
        total: result.total,
        totalPages: result.totalPages,
      },
    };
  }

  async getMyAssignment(staffId: string, assignmentId: string) {
    await this.requireActiveRole(
      staffId,
      DELIVERY_STAFF_ROLES,
      'Only active delivery staff can access assignments',
    );

    const assignment = await this.deliveryRepo.findAssignmentById(assignmentId);
    if (!assignment) {
      throw new NotFoundException('Assignment not found');
    }
    if (assignment.deliveryStaffId !== staffId) {
      throw new ForbiddenException('Cannot access another staff member assignment');
    }
    return assignment;
  }

  async updateMyAssignmentStatus(staffId: string, assignmentId: string, dto: UpdateDeliveryStatusDto) {
    await this.requireActiveRole(
      staffId,
      DELIVERY_STAFF_ROLES,
      'Only active delivery staff can update assignments',
    );

    try {
      return await this.deliveryRepo.runInTransaction(async (tx: any) => {
        // Lock assignment row for update
        const assignmentRows = await tx.$queryRaw`
          SELECT * FROM "delivery_assignments" WHERE "id" = ${assignmentId}::uuid FOR UPDATE
        `;
        const assignment = assignmentRows[0];
        if (!assignment) {
          throw new NotFoundException('Assignment not found');
        }
        // `$queryRaw` returns database column names, not Prisma model fields.
        if (assignment.delivery_staff_id !== staffId) {
          throw new ForbiddenException('Cannot update another staff member assignment');
        }

        if (!isValidDeliveryTransition(assignment.status, dto.status)) {
          throw new BadRequestException('Invalid status transition from ' + assignment.status + ' to ' + dto.status);
        }

        const updated = await this.deliveryRepo.updateAssignmentStatus(
          assignmentId,
          dto.status,
          dto.notes,
          tx,
        );
        return updated;
      });
    } catch (error: any) {
      if (error.code === 'P2002' || error.code === '23505') {
        throw new ConflictException('Assignment conflict');
      }
      throw error;
    }
  }

  /**
   * Records cash collected by the authenticated delivery staff member for an
   * assignment's COD order.
   *
   * ## Authorisation and ownership
   *
   * The staff identity is the authenticated user id, never a request field. The
   * service re-reads the user's role and status, then checks that the assignment
   * belongs to that staff member and is still active. Both checks are repeated
   * after the assignment row is locked, so a concurrent reassignment cannot turn
   * a valid pre-read into an unauthorised write.
   *
   * ## Transaction and concurrency
   *
   * The order row is locked first, matching the assignment/reassignment lock
   * order. That serialises concurrent collections for the same order and avoids a
   * deadlock with a manager reassigning it. The collection's unique `order_id`
   * index is the final duplicate guard if the application-level read is raced.
   * A linked `Payment` row is settled with a guarded `updateMany` in the same
   * transaction, so the collection and payment state commit or roll back together.
   *
   * ## Receipt proof
   *
   * An optional multipart file is uploaded to Cloudinary before the database
   * transaction, because a remote call cannot be part of a local transaction. If
   * the transaction then fails, the uploaded asset is deleted again. The stored
   * JSON is built only from Cloudinary's response; no client-supplied URL is
   * accepted.
   */
  async collectCod(
    staffId: string,
    assignmentId: string,
    dto: CollectCodDto,
    receiptProofFile?: UploadedReceiptFile,
  ) {
    await this.requireActiveRole(
      staffId,
      DELIVERY_STAFF_ROLES,
      'Only active delivery staff can collect COD payments',
    );

    const assignment = await this.deliveryRepo.findAssignmentById(assignmentId);
    if (!assignment) {
      throw new NotFoundException('Assignment not found');
    }

    this.assertStaffOwnsActiveAssignment(assignment, staffId);
    this.assertCollectibleOrder(assignment.order, dto);

    const existing = await this.deliveryRepo.findCodCollectionByOrderId(
      assignment.orderId,
    );
    if (existing) {
      throw new ConflictException(
        'COD collection already recorded for this order',
      );
    }

    const uploaded =
      receiptProofFile === undefined
        ? undefined
        : await this.cloudinaryService.upload({
            buffer: receiptProofFile.buffer,
            mimeType: receiptProofFile.mimetype,
          });

    const receiptProof: Prisma.InputJsonValue | undefined =
      uploaded === undefined
        ? undefined
        : {
            secureUrl: uploaded.secureUrl,
            publicId: uploaded.publicId,
            width: uploaded.width,
            height: uploaded.height,
            format: uploaded.format,
            bytes: uploaded.bytes,
          };

    try {
      return await this.deliveryRepo.runInTransaction(async (tx) => {
        const lockedOrder = await this.deliveryRepo.lockOrderForUpdate(
          assignment.orderId,
          tx,
        );
        if (lockedOrder === null) {
          throw new NotFoundException('Order not found');
        }

        const lockedAssignment =
          await this.deliveryRepo.lockAssignmentForUpdate(assignmentId, tx);
        if (lockedAssignment === null) {
          throw new NotFoundException('Assignment not found');
        }
        if (lockedAssignment.order_id !== assignment.orderId) {
          throw new ConflictException(
            'Assignment no longer belongs to this order',
          );
        }

        this.assertStaffOwnsActiveAssignment(
          {
            deliveryStaffId: lockedAssignment.delivery_staff_id,
            status: lockedAssignment.status,
            endedAt: lockedAssignment.ended_at,
          },
          staffId,
        );

        const order = await this.deliveryRepo.findOrderForCodCollection(
          lockedAssignment.order_id,
          tx,
        );
        if (order === null) {
          throw new NotFoundException('Order not found');
        }

        this.assertCollectibleOrder(order, dto);

        const duplicate = await this.deliveryRepo.findCodCollectionByOrderId(
          order.id,
          tx,
        );
        if (duplicate) {
          throw new ConflictException(
            'COD collection already recorded for this order',
          );
        }

        const payment = await this.deliveryRepo.findPaymentForOrder(order.id, tx);
        if (payment !== null) {
          const settled =
            await this.deliveryRepo.markPaymentPaidForCodCollection(
              payment.id,
              order.id,
              tx,
            );
          if (!settled) {
            throw new ConflictException(
              'Payment for this order is already settled',
            );
          }
        }

        return this.deliveryRepo.createCodCollection(
          {
            orderId: order.id,
            paymentId: payment?.id ?? null,
            collectedById: staffId,
            amount: dto.amount,
            currency: dto.currency,
            notes: dto.notes,
            receiptProof,
          },
          tx,
        );
      });
    } catch (error) {
      if (uploaded !== undefined) {
        await this.deleteUploadedReceipt(uploaded.publicId);
      }

      if (isUniqueConstraintError(error)) {
        throw new ConflictException(
          'COD collection already recorded for this order',
        );
      }

      throw error;
    }
  }

  /** Rejects an assignment that is not owned by the caller or is no longer active. */
  private assertStaffOwnsActiveAssignment(
    assignment: {
      deliveryStaffId: string;
      status: DeliveryStatus;
      endedAt: Date | null;
    },
    staffId: string,
  ): void {
    if (assignment.deliveryStaffId !== staffId) {
      throw new ForbiddenException(
        'Cannot collect COD for another staff member assignment',
      );
    }

    if (
      assignment.endedAt !== null ||
      assignment.status === DeliveryStatus.DELIVERED ||
      assignment.status === DeliveryStatus.RETURNED
    ) {
      throw new BadRequestException('Assignment is not active');
    }
  }

  /** Rejects an order that is not COD or whose money does not match the request. */
  private assertCollectibleOrder(
    order: {
      paymentMethod: string | null;
      totalAmount: Prisma.Decimal;
      currency: string;
    },
    dto: CollectCodDto,
  ): void {
    if (order.paymentMethod !== 'COD') {
      throw new BadRequestException('Order is not a COD order');
    }

    if (!new Prisma.Decimal(dto.amount).equals(order.totalAmount)) {
      throw new BadRequestException(
        'Collection amount must equal the order total',
      );
    }

    if (order.currency.trim() !== dto.currency) {
      throw new BadRequestException(
        'Collection currency must match the order currency',
      );
    }
  }

  /** Deletes an uploaded receipt whose database write did not commit. */
  private async deleteUploadedReceipt(publicId: string): Promise<void> {
    try {
      await this.cloudinaryService.deleteAsset(publicId);
    } catch (error) {
      this.logger.error(
        `Failed to delete orphaned COD receipt ${publicId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

/** Detects either Prisma's unique-constraint code or PostgreSQL's SQLSTATE. */
function isUniqueConstraintError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }

  const code = (error as { code?: unknown }).code;

  return code === 'P2002' || code === '23505';
}

