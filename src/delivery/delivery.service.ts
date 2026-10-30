import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DeliveryRepository } from './repositories/delivery.repository.js';
import { AssignDeliveryDto } from './dto/assign-delivery.dto.js';
import { ReassignDeliveryDto } from './dto/reassign-delivery.dto.js';
import { UpdateDeliveryStatusDto } from './dto/update-delivery-status.dto.js';
import { DeliveryQueryDto } from './dto/delivery-query.dto.js';
import { Role } from '../generated/prisma/enums.js';
import { ELIGIBLE_ORDER_STATUSES_FOR_ASSIGNMENT, isValidDeliveryTransition } from './constants/delivery-status.constants.js';
import { Prisma } from '../generated/prisma/client.js';

@Injectable()
export class DeliveryService {
  constructor(private readonly deliveryRepo: DeliveryRepository) {}

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
    const assignedBy = await this.deliveryRepo.findUserById(assignedById);
    if (!assignedBy || assignedBy.role !== Role.DELIVERY_MANAGER) {
      throw new ForbiddenException('Only delivery managers can assign orders');
    }

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
        if (staff.status !== 'ACTIVE') {
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
    const assignedBy = await this.deliveryRepo.findUserById(assignedById);
    if (!assignedBy || assignedBy.role !== Role.DELIVERY_MANAGER) {
      throw new ForbiddenException('Only delivery managers can reassign orders');
    }

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
        if (staff.status !== 'ACTIVE') {
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
    const staff = await this.deliveryRepo.findUserById(staffId);
    if (!staff || staff.role !== Role.DELIVERY_STAFF) {
      throw new ForbiddenException('Only delivery staff can access their assignments');
    }

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
    const staff = await this.deliveryRepo.findUserById(staffId);
    if (!staff || staff.role !== Role.DELIVERY_STAFF) {
      throw new ForbiddenException('Only delivery staff can access assignments');
    }

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
    const staff = await this.deliveryRepo.findUserById(staffId);
    if (!staff || staff.role !== Role.DELIVERY_STAFF) {
      throw new ForbiddenException('Only delivery staff can update assignments');
    }

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
        if (assignment.deliveryStaffId !== staffId) {
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
}
