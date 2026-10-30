import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

export type DeliveryTransactionClient = Prisma.TransactionClient;

@Injectable()
export class DeliveryRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findOrderById(orderId: string, tx?: DeliveryTransactionClient) {
    const client = tx ?? this.prisma;
    return client.order.findUnique({
      where: { id: orderId },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
          },
        },
        items: true,
        payments: {
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        },
        deliveryAssignments: {
          orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
          include: {
            deliveryStaff: {
              select: { id: true, firstName: true, lastName: true, email: true },
            },
            assignedBy: {
              select: { id: true, firstName: true, lastName: true, email: true },
            },
          },
        },
      },
    });
  }

  async findUserById(userId: string, tx?: DeliveryTransactionClient) {
    const client = tx ?? this.prisma;
    return client.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, status: true, firstName: true, lastName: true, email: true },
    });
  }

  async findOrderByIdForUpdate(orderId: string, tx: DeliveryTransactionClient) {
    const rows = await tx.$queryRaw<Array<any>>`
      SELECT * FROM "orders" WHERE "id" = ${orderId}::uuid FOR UPDATE
    `;
    return rows[0] || null;
  }

  async findActiveAssignmentForUpdate(orderId: string, tx: DeliveryTransactionClient) {
    return tx.deliveryAssignment.findFirst({
      where: { orderId },
      orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
      // Note: Prisma doesn't have direct FOR UPDATE in findFirst easily,
      // but we'll use raw query or rely on transaction isolation
    });
  }

  async endAssignment(assignmentId: string, tx?: DeliveryTransactionClient) {
    const client = tx ?? this.prisma;
    return client.deliveryAssignment.update({
      where: { id: assignmentId },
      data: { endedAt: new Date() },
    });
  }

  async createAssignment(
    data: {
      orderId: string;
      deliveryStaffId: string;
      assignedById: string;
      status?: 'ASSIGNED' | 'PENDING_ASSIGNMENT';
    },
    tx?: DeliveryTransactionClient,
  ) {
    const client = tx ?? this.prisma;
    return client.deliveryAssignment.create({
      data: {
        orderId: data.orderId,
        deliveryStaffId: data.deliveryStaffId,
        assignedById: data.assignedById,
        status: data.status ?? 'ASSIGNED',
      },
      include: {
        deliveryStaff: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
        assignedBy: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
      },
    });
  }

  async updateAssignmentStatus(
    assignmentId: string,
    status: any,
    notes?: string,
    tx?: DeliveryTransactionClient,
  ) {
    const client = tx ?? this.prisma;
    const data: any = { status };
    if (notes !== undefined) {
      data.notes = notes;
    }
    if (status === 'OUT_FOR_DELIVERY') {
      const existing = await client.deliveryAssignment.findUnique({ where: { id: assignmentId }, select: { startedAt: true } });
      if (existing && !existing.startedAt) {
        data.startedAt = new Date();
      }
    }
    if (status === 'DELIVERED') {
      data.deliveredAt = new Date();
      if (!data.endedAt) {
        data.endedAt = new Date();
      }
    }
    if (status === 'RETURNED') {
      if (!data.endedAt) {
        data.endedAt = new Date();
      }
    }
    if (status === 'FAILED_DELIVERY') {
      // Don't end assignment on failed delivery - can retry
    }
    return client.deliveryAssignment.update({
      where: { id: assignmentId },
      data,
      include: {
        deliveryStaff: true,
        assignedBy: true,
        order: true,
      },
    });
  }

  async findAssignmentById(assignmentId: string, tx?: DeliveryTransactionClient) {
    const client = tx ?? this.prisma;
    return client.deliveryAssignment.findUnique({
      where: { id: assignmentId },
      include: {
        order: true,
        deliveryStaff: true,
        assignedBy: true,
      },
    });
  }

  async findAssignmentsForStaff(
    staffId: string,
    filters: { status?: string; page?: number; limit?: number },
    tx?: DeliveryTransactionClient,
  ) {
    const client = tx ?? this.prisma;
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: any = { deliveryStaffId: staffId };
    if (filters.status) {
      where.status = filters.status;
    }

    const [items, total] = await Promise.all([
      client.deliveryAssignment.findMany({
        where,
        include: {
          order: {
            include: {
              user: {
                select: { id: true, firstName: true, lastName: true, email: true, phone: true },
              },
              items: true,
            },
          },
          assignedBy: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
        },
        orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
      }),
      client.deliveryAssignment.count({ where }),
    ]);

    return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async findAllDeliveryOrders(
    filters: { status?: string; deliveryStaffId?: string; search?: string; page?: number; limit?: number },
    tx?: DeliveryTransactionClient,
  ) {
    const client = tx ?? this.prisma;
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: any = {
      deliveryAssignments: {
        some: {},
      },
    };

    if (filters.deliveryStaffId) {
      where.deliveryAssignments = {
        some: { deliveryStaffId: filters.deliveryStaffId },
      };
    }

    if (filters.status) {
      where.deliveryAssignments = {
        some: { status: filters.status as any },
      };
    }

    if (filters.search) {
      where.OR = [
        { orderNumber: { contains: filters.search, mode: 'insensitive' } },
        { user: { firstName: { contains: filters.search, mode: 'insensitive' } } },
        { user: { lastName: { contains: filters.search, mode: 'insensitive' } } },
        { user: { email: { contains: filters.search, mode: 'insensitive' } } },
      ];
    }

    const [items, total] = await Promise.all([
      client.order.findMany({
        where,
        include: {
          user: {
            select: { id: true, firstName: true, lastName: true, email: true, phone: true },
          },
          items: true,
          payments: {
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          },
          deliveryAssignments: {
            orderBy: [{ assignedAt: 'desc' }, { id: 'desc' }],
            include: {
              deliveryStaff: {
                select: { id: true, firstName: true, lastName: true, email: true },
              },
              assignedBy: {
                select: { id: true, firstName: true, lastName: true, email: true },
              },
            },
          },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
      }),
      client.order.count({ where }),
    ]);

    return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async findPaymentById(paymentId: string, tx?: DeliveryTransactionClient) {
    const client = tx ?? this.prisma;
    return client.payment.findUnique({
      where: { id: paymentId },
    });
  }

  async findCodCollectionByOrderId(orderId: string, tx?: DeliveryTransactionClient) {
    const client = tx ?? this.prisma;
    return client.codCollection.findUnique({
      where: { orderId },
    });
  }

  async findCodCollectionByPaymentId(paymentId: string, tx?: DeliveryTransactionClient) {
    const client = tx ?? this.prisma;
    return client.codCollection.findUnique({
      where: { paymentId },
    });
  }

  async createCodCollection(
    data: {
      orderId: string;
      paymentId?: string | null;
      collectedById: string;
      amount: any;
      currency: string;
      notes?: string;
      receiptProof?: any;
    },
    tx?: DeliveryTransactionClient,
  ) {
    const client = tx ?? this.prisma;
    return client.codCollection.create({
      data,
      include: {
        order: true,
        payment: true,
        collectedBy: true,
      },
    });
  }

  async runInTransaction<T>(fn: (tx: DeliveryTransactionClient) => Promise<T>): Promise<T> {
    return (this.prisma as any).$transaction(fn);
  }

  async updatePaymentStatus(
    paymentId: string,
    status: string,
    tx?: DeliveryTransactionClient,
  ) {
    const client = tx ?? this.prisma;
    return client.payment.update({
      where: { id: paymentId },
      data: { status },
    });
  }
}
