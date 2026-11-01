import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { ACTIVE_USER_STATUS } from '../../common/constants/user-status.constants.js';
import { DeliveryStatus } from '../../generated/prisma/enums.js';
import { PAYMENT_STATUS } from '../../payments/constants/payment-status.constants.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { CodReconciliationDiscrepancyType } from '../dto/admin-cod-reconciliation-discrepancy.dto.js';
import type {
  CodReconciliationPeriod,
  CodReconciliationSortBy,
  CodReconciliationSortOrder,
} from '../dto/admin-cod-reconciliation-query.dto.js';

export type DeliveryTransactionClient = Prisma.TransactionClient;

/** The assignment columns needed to authorise and validate a COD collection. */
export interface LockedAssignmentRow {
  id: string;
  order_id: string;
  delivery_staff_id: string;
  status: DeliveryStatus;
  ended_at: Date | null;
}

/** Filters for administrative COD financial reconciliation queries. */
export interface CodReconciliationFilters {
  startDate?: Date | string;
  endDate?: Date | string;
  endDateExclusive?: Date | string;
  staffId?: string;
  orderId?: string;
  orderNumber?: string;
  status?: string;
  currency?: string;
  sortBy?: CodReconciliationSortBy | string;
  sortOrder?: CodReconciliationSortOrder | string;
  period?: CodReconciliationPeriod | string;
  page?: number;
  limit?: number;
}

/** One record in the COD financial reconciliation listing. */
export interface CodReconciliationRecordItem {
  orderId: string;
  orderNumber: string | null;
  orderStatus: string | null;
  paymentMethod: string | null;
  totalAmount: Prisma.Decimal;
  expectedAmount: Prisma.Decimal;
  currency: string;
  collectedAmount: Prisma.Decimal | null;
  collectionId: string | null;
  collectedAt: Date | null;
  collectedById: string | null;
  collectedBy: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  } | null;
  deliveryStaffId: string | null;
  deliveryStaff: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  } | null;
  deliveredAt: Date | null;
  discrepancy: boolean;
  discrepancyType: CodReconciliationDiscrepancyType | null;
}

/** One uncollected delivered COD order. */
export interface UncollectedDeliveredCodOrderItem {
  orderId: string;
  orderNumber: string;
  orderStatus: string;
  totalAmount: Prisma.Decimal;
  expectedAmount: Prisma.Decimal;
  currency: string;
  deliveryStaffId: string | null;
  deliveryStaff: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  } | null;
  deliveredAt: Date | null;
}

/** One reconciliation discrepancy item. */
export interface CodReconciliationDiscrepancyItem {
  orderId: string;
  orderNumber: string | null;
  orderStatus: string | null;
  discrepancyType: CodReconciliationDiscrepancyType;
  totalAmount: Prisma.Decimal;
  expectedAmount: Prisma.Decimal;
  collectedAmount: Prisma.Decimal | null;
  actualAmount: Prisma.Decimal | null;
  currency: string;
  collectionId: string | null;
}

/** Currency-scoped reconciliation totals. */
export interface CodReconciliationCurrencyTotal {
  currency: string;
  collectedAmount: Prisma.Decimal;
  expectedAmount: Prisma.Decimal;
  outstandingAmount: Prisma.Decimal;
  count: number;
}

/** Period-scoped breakdown row. */
export interface CodReconciliationPeriodBreakdown {
  period: string;
  currency: string;
  collectedAmount: Prisma.Decimal;
  expectedAmount: Prisma.Decimal;
  outstandingAmount: Prisma.Decimal;
  count: number;
}

/** Staff-scoped breakdown row. */
export interface CodReconciliationStaffBreakdown {
  staffId: string;
  staff: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  };
  currency: string;
  collectedAmount: Prisma.Decimal;
  expectedAmount: Prisma.Decimal;
  outstandingAmount: Prisma.Decimal;
  count: number;
}

/** Aggregated COD reconciliation summary result. */
export interface CodReconciliationSummaryResult {
  totalCollections: number;
  totalsByCurrency: CodReconciliationCurrencyTotal[];
  expectedAmountByCurrency: Array<{
    currency: string;
    totalAmount: Prisma.Decimal;
  }>;
  outstandingAmountByCurrency: Array<{
    currency: string;
    totalAmount: Prisma.Decimal;
  }>;
  collectionCount: number;
  discrepancyCount: number;
  firstCollectionAt: Date | null;
  lastCollectionAt: Date | null;
  periodBreakdown: CodReconciliationPeriodBreakdown[];
  staffBreakdown: CodReconciliationStaffBreakdown[];
}

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
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
              },
            },
            assignedBy: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
              },
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
      select: {
        id: true,
        role: true,
        status: true,
        firstName: true,
        lastName: true,
        email: true,
      },
    });
  }

  findActiveDeliveryStaff() {
    return this.prisma.user.findMany({
      where: {
        role: 'DELIVERY_STAFF',
        status: ACTIVE_USER_STATUS,
      },
      select: { id: true, firstName: true, lastName: true, email: true },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }, { id: 'asc' }],
    });
  }

  async findOrderByIdForUpdate(orderId: string, tx: DeliveryTransactionClient) {
    const rows = await tx.$queryRaw<Array<any>>`
      SELECT * FROM "orders" WHERE "id" = ${orderId}::uuid FOR UPDATE
    `;
    return rows[0] || null;
  }

  /**
   * Locks an order row and returns only its id.
   *
   * COD collection takes this lock first, matching the order-first locking order
   * used by assignment and reassignment, so a collection cannot deadlock with a
   * concurrent reassignment of the same order.
   */
  async lockOrderForUpdate(
    orderId: string,
    tx: DeliveryTransactionClient,
  ): Promise<{ id: string } | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "orders" WHERE "id" = ${orderId}::uuid FOR UPDATE
    `;

    return rows[0] ?? null;
  }

  async findAssignmentOrderId(assignmentId: string): Promise<string | null> {
    const assignment = await this.prisma.deliveryAssignment.findUnique({
      where: { id: assignmentId },
      select: { orderId: true },
    });

    return assignment?.orderId ?? null;
  }

  /**
   * Locks an assignment row and returns the columns a COD collection checks.
   *
   * `$queryRaw` returns database column names, so the shape is declared here
   * rather than reusing the Prisma model type.
   */
  async lockAssignmentForUpdate(
    assignmentId: string,
    tx: DeliveryTransactionClient,
  ): Promise<LockedAssignmentRow | null> {
    const rows = await tx.$queryRaw<Array<LockedAssignmentRow>>`
      SELECT "id", "order_id", "delivery_staff_id", "status", "ended_at"
      FROM "delivery_assignments"
      WHERE "id" = ${assignmentId}::uuid
      FOR UPDATE
    `;

    return rows[0] ?? null;
  }

  async transitionShippedOrderToDelivered(
    orderId: string,
    tx: DeliveryTransactionClient,
  ): Promise<boolean> {
    const updated = await tx.order.updateMany({
      where: { id: orderId, status: 'SHIPPED' },
      data: { status: 'DELIVERED' },
    });

    return updated.count === 1;
  }

  /**
   * Reads the order fields COD collection validates, without the customer and
   * assignment graph `findOrderById` includes.
   */
  async findOrderForCodCollection(
    orderId: string,
    tx: DeliveryTransactionClient,
  ) {
    return tx.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        paymentMethod: true,
        totalAmount: true,
        currency: true,
      },
    });
  }

  async findActiveAssignmentForUpdate(
    orderId: string,
    tx: DeliveryTransactionClient,
  ) {
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
      const existing = await client.deliveryAssignment.findUnique({
        where: { id: assignmentId },
        select: { startedAt: true },
      });
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

  async findAssignmentById(
    assignmentId: string,
    tx?: DeliveryTransactionClient,
  ) {
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
                select: {
                  id: true,
                  firstName: true,
                  lastName: true,
                  email: true,
                  phone: true,
                },
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
    filters: {
      status?: string;
      deliveryStaffId?: string;
      search?: string;
      page?: number;
      limit?: number;
    },
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
        {
          user: {
            firstName: { contains: filters.search, mode: 'insensitive' },
          },
        },
        {
          user: { lastName: { contains: filters.search, mode: 'insensitive' } },
        },
        { user: { email: { contains: filters.search, mode: 'insensitive' } } },
      ];
    }

    const [items, total] = await Promise.all([
      client.order.findMany({
        where,
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
                select: {
                  id: true,
                  firstName: true,
                  lastName: true,
                  email: true,
                },
              },
              assignedBy: {
                select: {
                  id: true,
                  firstName: true,
                  lastName: true,
                  email: true,
                },
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

  /**
   * Returns the newest payment attempt for an order, if one exists.
   *
   * COD checkout normally creates no `Payment` row at all. This read exists so a
   * collection can link and settle a pre-existing row without inventing one.
   */
  async findPaymentForOrder(orderId: string, tx?: DeliveryTransactionClient) {
    const client = tx ?? this.prisma;
    return client.payment.findFirst({
      where: { orderId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, status: true },
    });
  }

  /**
   * Marks a linked payment `PAID` as part of a COD collection.
   *
   * Guarded on both the order and `status != PAID`; returns whether this call was
   * the writer. A concurrent settlement therefore matches zero rows instead of
   * overwriting `paidAt`.
   */
  async markPaymentPaidForCodCollection(
    paymentId: string,
    orderId: string,
    tx: DeliveryTransactionClient,
  ): Promise<boolean> {
    const updated = await tx.payment.updateMany({
      where: {
        id: paymentId,
        orderId,
        status: { not: PAYMENT_STATUS.PAID },
      },
      data: {
        status: PAYMENT_STATUS.PAID,
        paidAt: new Date(),
        paymentMethod: 'COD',
      },
    });

    return updated.count === 1;
  }

  async findCodCollectionByOrderId(
    orderId: string,
    tx?: DeliveryTransactionClient,
  ) {
    const client = tx ?? this.prisma;
    return client.codCollection.findUnique({
      where: { orderId },
    });
  }

  async findCodCollectionByPaymentId(
    paymentId: string,
    tx?: DeliveryTransactionClient,
  ) {
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
      amount: Prisma.Decimal | string;
      currency: string;
      notes?: string;
      receiptProof?: Prisma.InputJsonValue;
    },
    tx?: DeliveryTransactionClient,
  ) {
    const client = tx ?? this.prisma;
    return client.codCollection.create({
      data,
      include: {
        order: {
          select: {
            id: true,
            orderNumber: true,
            status: true,
            paymentMethod: true,
            totalAmount: true,
            currency: true,
          },
        },
        payment: {
          select: {
            id: true,
            status: true,
            amount: true,
            currency: true,
            paymentMethod: true,
            paidAt: true,
          },
        },
        collectedBy: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
      },
    });
  }

  async runInTransaction<T>(
    fn: (tx: DeliveryTransactionClient) => Promise<T>,
  ): Promise<T> {
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

  /** Builds the `collectedById`-scoped `cod_collections` where clause. */
  private codCollectionsWhere(
    staffId: string,
    filters: {
      startDate?: Date;
      endDate?: Date;
      currency?: string;
      orderId?: string;
    },
  ) {
    const where: any = { collectedById: staffId };

    const collectedAt: any = {};
    if (filters.startDate) {
      collectedAt.gte = filters.startDate;
    }
    if (filters.endDate) {
      collectedAt.lte = filters.endDate;
    }
    if (Object.keys(collectedAt).length > 0) {
      where.collectedAt = collectedAt;
    }

    if (filters.currency) {
      where.currency = filters.currency;
    }
    if (filters.orderId) {
      where.orderId = filters.orderId;
    }

    return where;
  }

  /**
   * Returns the authenticated staff member's own COD collections, paginated.
   *
   * Ordering is deterministic (`collectedAt DESC, id DESC`) so pagination is
   * stable, and the `order` relation is included in the same query so there is
   * no N+1 when hydrating order information.
   */
  async findCodCollectionsForStaff(
    staffId: string,
    filters: {
      startDate?: Date;
      endDate?: Date;
      currency?: string;
      orderId?: string;
      page?: number;
      limit?: number;
    },
    tx?: DeliveryTransactionClient,
  ) {
    const client = tx ?? this.prisma;
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

    const where = this.codCollectionsWhere(staffId, filters);

    const [items, total] = await Promise.all([
      client.codCollection.findMany({
        where,
        include: {
          order: {
            select: {
              id: true,
              orderNumber: true,
              status: true,
              paymentMethod: true,
              totalAmount: true,
              currency: true,
            },
          },
        },
        orderBy: [{ collectedAt: 'desc' }, { id: 'desc' }],
        skip,
        take: limit,
      }),
      client.codCollection.count({ where }),
    ]);

    return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  /**
   * Aggregates the authenticated staff member's own COD collections.
   *
   * Amounts are aggregated per currency in the database and never mixed, so a
   * staff member holding collections in several currencies sees each currency
   * separated. Uses `collectedAt` as the reporting timestamp.
   */
  async summarizeCodCollectionsForStaff(
    staffId: string,
    filters: {
      startDate?: Date;
      endDate?: Date;
      currency?: string;
    },
    tx?: DeliveryTransactionClient,
  ) {
    const client = tx ?? this.prisma;
    const where = this.codCollectionsWhere(staffId, filters);

    const [totalsByCurrency, aggregate] = await Promise.all([
      client.codCollection.groupBy({
        by: ['currency'],
        where,
        _sum: { amount: true },
        _count: true,
      }),
      client.codCollection.aggregate({
        where,
        _count: true,
        _min: { collectedAt: true },
        _max: { collectedAt: true },
      }),
    ]);

    return {
      totalsByCurrency: totalsByCurrency.map((entry) => ({
        currency: entry.currency,
        totalAmount: entry._sum.amount ?? null,
        count: entry._count,
      })),
      totalCollections: aggregate._count,
      firstCollectionAt: aggregate._min.collectedAt ?? null,
      lastCollectionAt: aggregate._max.collectedAt ?? null,
    };
  }

  /**
   * Returns per-period collection totals for the authenticated staff member.
   *
   * Each row keeps its own currency so mixed-currency periods stay separated.
   * Periods are computed in UTC from `collectedAt`.
   */
  async summarizeCodCollectionsByPeriod(
    staffId: string,
    filters: {
      startDate?: Date;
      endDate?: Date;
      currency?: string;
      period: 'daily' | 'weekly' | 'monthly';
    },
    tx?: DeliveryTransactionClient,
  ) {
    const client = tx ?? this.prisma;

    const conditions: Prisma.Sql[] = [
      Prisma.sql`"collected_by_id" = ${staffId}`,
    ];
    if (filters.startDate) {
      conditions.push(Prisma.sql`"collected_at" >= ${filters.startDate}`);
    }
    if (filters.endDate) {
      conditions.push(Prisma.sql`"collected_at" <= ${filters.endDate}`);
    }
    if (filters.currency) {
      conditions.push(Prisma.sql`currency = ${filters.currency}`);
    }

    const periodSelect =
      filters.period === 'weekly'
        ? "to_char(date_trunc('week', \"collected_at\" AT TIME ZONE 'UTC'), 'YYYY-MM-DD')"
        : filters.period === 'monthly'
          ? "to_char(date_trunc('month', \"collected_at\" AT TIME ZONE 'UTC'), 'YYYY-MM')"
          : "to_char(\"collected_at\" AT TIME ZONE 'UTC', 'YYYY-MM-DD')";

    const rows = await client.$queryRaw<
      Array<{
        period: string;
        currency: string;
        total_amount: Prisma.Decimal;
        count: unknown;
      }>
    >`
      SELECT ${Prisma.raw(periodSelect)} AS period,
             currency,
             sum("amount") AS total_amount,
             count(*) AS count
      FROM "cod_collections"
      WHERE ${Prisma.join(conditions, ' AND ')}
      GROUP BY 1, 2
      ORDER BY 1 ASC, 2 ASC
    `;

    return rows.map((row) => ({
      period: row.period,
      currency: row.currency,
      totalAmount: row.total_amount,
      count: Number(row.count),
    }));
  }

  /**
   * Builds the admin-scoped `cod_collections` where clause.
   *
   * Unlike the staff-scoped helper, this one is not narrowed by `collectedById`
   * unless `staffId` is supplied — an administrator may read every collection.
   */
  private adminCodCollectionsWhere(filters: {
    startDate?: Date;
    endDate?: Date;
    staffId?: string;
    orderId?: string;
    orderNumber?: string;
    currency?: string;
  }) {
    const where: any = {};

    const collectedAt: any = {};
    if (filters.startDate) {
      collectedAt.gte = filters.startDate;
    }
    if (filters.endDate) {
      collectedAt.lte = filters.endDate;
    }
    if (Object.keys(collectedAt).length > 0) {
      where.collectedAt = collectedAt;
    }

    if (filters.staffId) {
      where.collectedById = filters.staffId;
    }
    if (filters.orderId) {
      where.orderId = filters.orderId;
    }
    if (filters.orderNumber) {
      where.order = {
        orderNumber: { contains: filters.orderNumber, mode: 'insensitive' },
      };
    }
    if (filters.currency) {
      where.currency = filters.currency;
    }

    return where;
  }

  /**
   * Returns one page of COD collections for an administrator, with the matching
   * total.
   *
   * Sorting is deterministic: the requested column first, then `id DESC` as a
   * tiebreak. The `order` and `collectedBy` relations are included in the same
   * query so there is no N+1 when hydrating order and staff information.
   */
  async findCodCollectionsForAdmin(
    filters: {
      startDate?: Date;
      endDate?: Date;
      staffId?: string;
      orderId?: string;
      orderNumber?: string;
      currency?: string;
      sortBy: string;
      sortOrder: string;
      page: number;
      limit: number;
    },
    tx?: DeliveryTransactionClient,
  ) {
    const client = tx ?? this.prisma;
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

    const where = this.adminCodCollectionsWhere(filters);

    const allowedSortBy = ['collectedAt', 'amount', 'currency', 'id'];
    const sortBy = allowedSortBy.includes(filters.sortBy)
      ? filters.sortBy
      : 'collectedAt';
    const sortOrder = filters.sortOrder === 'asc' ? 'asc' : 'desc';

    const orderBy: any[] = [{ [sortBy]: sortOrder }, { id: 'desc' }];

    const [items, total] = await Promise.all([
      client.codCollection.findMany({
        where,
        include: {
          order: {
            select: {
              id: true,
              orderNumber: true,
            },
          },
          collectedBy: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
            },
          },
        },
        orderBy,
        skip,
        take: limit,
      }),
      client.codCollection.count({ where }),
    ]);

    return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  /**
   * Returns one COD collection for an administrator, with its order, collecting
   * staff member and linked payment.
   *
   * Returns `null` when no such collection exists; the service turns that into
   * a 404.
   */
  async findCodCollectionForAdminById(
    collectionId: string,
    tx?: DeliveryTransactionClient,
  ) {
    const client = tx ?? this.prisma;
    return client.codCollection.findUnique({
      where: { id: collectionId },
      include: {
        order: {
          select: {
            id: true,
            orderNumber: true,
          },
        },
        payment: {
          select: {
            id: true,
            status: true,
            amount: true,
            currency: true,
            paymentMethod: true,
            paidAt: true,
          },
        },
        collectedBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
      },
    });
  }

  /**
   * Aggregates COD collections globally for an administrator.
   *
   * Amounts are aggregated per currency in the database and never mixed.
   */
  async summarizeCodCollectionsForAdmin(
    filters: {
      startDate?: Date;
      endDate?: Date;
      staffId?: string;
      orderId?: string;
      orderNumber?: string;
      currency?: string;
    },
    tx?: DeliveryTransactionClient,
  ) {
    const client = tx ?? this.prisma;
    const where = this.adminCodCollectionsWhere(filters);

    const [totalsByCurrency, aggregate] = await Promise.all([
      client.codCollection.groupBy({
        by: ['currency'],
        where,
        _sum: { amount: true },
        _count: true,
      }),
      client.codCollection.aggregate({
        where,
        _count: true,
        _min: { collectedAt: true },
        _max: { collectedAt: true },
      }),
    ]);

    return {
      totalsByCurrency: totalsByCurrency.map((entry) => ({
        currency: entry.currency,
        totalAmount: entry._sum.amount ?? null,
        count: entry._count,
      })),
      totalCollections: aggregate._count,
      firstCollectionAt: aggregate._min.collectedAt ?? null,
      lastCollectionAt: aggregate._max.collectedAt ?? null,
    };
  }

  /**
   * Returns per-period collection totals globally for an administrator.
   *
   * Each row keeps its own currency so mixed-currency periods stay separated.
   */
  async summarizeCodCollectionsByPeriodForAdmin(
    filters: {
      startDate?: Date;
      endDate?: Date;
      staffId?: string;
      orderId?: string;
      orderNumber?: string;
      currency?: string;
      period: 'daily' | 'weekly' | 'monthly';
    },
    tx?: DeliveryTransactionClient,
  ) {
    const client = tx ?? this.prisma;

    const conditions: Prisma.Sql[] = [];
    if (filters.startDate) {
      conditions.push(Prisma.sql`"collected_at" >= ${filters.startDate}`);
    }
    if (filters.endDate) {
      conditions.push(Prisma.sql`"collected_at" <= ${filters.endDate}`);
    }
    if (filters.staffId) {
      conditions.push(Prisma.sql`"collected_by_id" = ${filters.staffId}`);
    }
    if (filters.orderId) {
      conditions.push(Prisma.sql`"order_id" = ${filters.orderId}`);
    }
    if (filters.orderNumber) {
      conditions.push(
        Prisma.sql`EXISTS (SELECT 1 FROM "orders" o WHERE o."id" = "cod_collections"."order_id" AND o."order_number" ILIKE ${'%' + filters.orderNumber + '%'})`,
      );
    }
    if (filters.currency) {
      conditions.push(Prisma.sql`currency = ${filters.currency}`);
    }

    const whereClause =
      conditions.length > 0
        ? Prisma.join(conditions, ' AND ')
        : Prisma.sql`true`;

    const periodSelect =
      filters.period === 'weekly'
        ? "to_char(date_trunc('week', \"collected_at\" AT TIME ZONE 'UTC'), 'YYYY-MM-DD')"
        : filters.period === 'monthly'
          ? "to_char(date_trunc('month', \"collected_at\" AT TIME ZONE 'UTC'), 'YYYY-MM')"
          : "to_char(\"collected_at\" AT TIME ZONE 'UTC', 'YYYY-MM-DD')";

    const rows = await client.$queryRaw<
      Array<{
        period: string;
        currency: string;
        total_amount: Prisma.Decimal;
        count: unknown;
      }>
    >`
      SELECT ${Prisma.raw(periodSelect)} AS period,
             currency,
             sum("amount") AS total_amount,
             count(*) AS count
      FROM "cod_collections"
      WHERE ${whereClause}
      GROUP BY 1, 2
      ORDER BY 1 ASC, 2 ASC
    `;

    return rows.map((row) => ({
      period: row.period,
      currency: row.currency,
      totalAmount: row.total_amount,
      count: Number(row.count),
    }));
  }

  /**
   * Returns per-staff, per-currency collection totals globally for an
   * administrator.
   *
   * Each row keeps its own currency so mixed-currency staff totals stay
   * separated.
   */
  async summarizeCodCollectionsByStaffForAdmin(
    filters: {
      startDate?: Date;
      endDate?: Date;
      staffId?: string;
      orderId?: string;
      orderNumber?: string;
      currency?: string;
    },
    tx?: DeliveryTransactionClient,
  ) {
    const client = tx ?? this.prisma;
    const where = this.adminCodCollectionsWhere(filters);

    const rows = await client.codCollection.groupBy({
      by: ['collectedById', 'currency'],
      where,
      _sum: { amount: true },
      _count: true,
      orderBy: [{ collectedById: 'asc' }, { currency: 'asc' }],
    });

    const staffIds = [...new Set(rows.map((row) => row.collectedById))];
    const staff =
      staffIds.length > 0
        ? await client.user.findMany({
            where: { id: { in: staffIds } },
            select: { id: true, firstName: true, lastName: true, email: true },
          })
        : [];
    const staffById = new Map(staff.map((s) => [s.id, s]));

    return rows.map((row) => {
      // Every `collectedById` references a real user, so the lookup always
      // succeeds. The non-null assertion is safe by construction.
      const staffMember = staffById.get(row.collectedById)!;

      return {
        staffId: row.collectedById,
        staff: staffMember,
        currency: row.currency,
        totalAmount: row._sum.amount ?? null,
        count: row._count,
      };
    });
  } /** Builds parameterized SQL WHERE conditions for COD reconciliation queries. */
  private buildCodReconciliationConditions(
    filters: CodReconciliationFilters,
  ): Prisma.Sql[] {
    const conditions: Prisma.Sql[] = [
      Prisma.sql`o."status" = ${filters.status ?? 'DELIVERED'}`,
      Prisma.sql`(o."payment_method" = 'COD' OR cc."id" IS NOT NULL)`,
    ];

    if (filters.orderId) {
      conditions.push(Prisma.sql`o."id" = ${filters.orderId}::uuid`);
    }
    if (filters.orderNumber) {
      conditions.push(
        Prisma.sql`o."order_number" ILIKE ${'%' + filters.orderNumber + '%'}`,
      );
    }
    if (filters.currency) {
      conditions.push(Prisma.sql`o."currency" = ${filters.currency}`);
    }
    if (filters.startDate) {
      const start = new Date(filters.startDate);
      if (!Number.isNaN(start.getTime())) {
        conditions.push(Prisma.sql`lda."delivered_at" >= ${start}`);
      }
    }
    if (filters.endDate) {
      const end = new Date(filters.endDate);
      if (!Number.isNaN(end.getTime())) {
        conditions.push(Prisma.sql`lda."delivered_at" <= ${end}`);
      }
    }
    if (filters.endDateExclusive) {
      const end = new Date(filters.endDateExclusive);
      if (!Number.isNaN(end.getTime())) {
        conditions.push(Prisma.sql`lda."delivered_at" < ${end}`);
      }
    }
    if (filters.staffId) {
      conditions.push(
        Prisma.sql`(lda."delivery_staff_id" = ${filters.staffId}::uuid OR cc."collected_by_id" = ${filters.staffId}::uuid)`,
      );
    }

    return conditions;
  }

  /** Builds parameterized SQL WHERE conditions for uncollected delivered COD orders. */
  private buildUncollectedCodConditions(
    filters: CodReconciliationFilters,
  ): Prisma.Sql[] {
    const conditions: Prisma.Sql[] = [
      Prisma.sql`o."status" = ${filters.status ?? 'DELIVERED'}`,
      Prisma.sql`(o."payment_method" = 'COD' OR o."payment_method" IS NULL)`,
      Prisma.sql`NOT EXISTS (SELECT 1 FROM "cod_collections" cc WHERE cc."order_id" = o."id")`,
    ];

    if (filters.orderId) {
      conditions.push(Prisma.sql`o."id" = ${filters.orderId}::uuid`);
    }
    if (filters.orderNumber) {
      conditions.push(
        Prisma.sql`o."order_number" ILIKE ${'%' + filters.orderNumber + '%'}`,
      );
    }
    if (filters.currency) {
      conditions.push(Prisma.sql`o."currency" = ${filters.currency}`);
    }
    if (filters.startDate) {
      const start = new Date(filters.startDate);
      if (!Number.isNaN(start.getTime())) {
        conditions.push(Prisma.sql`lda."delivered_at" >= ${start}`);
      }
    }
    if (filters.endDate) {
      const end = new Date(filters.endDate);
      if (!Number.isNaN(end.getTime())) {
        conditions.push(Prisma.sql`lda."delivered_at" <= ${end}`);
      }
    }
    if (filters.staffId) {
      conditions.push(
        Prisma.sql`lda."delivery_staff_id" = ${filters.staffId}::uuid`,
      );
    }

    return conditions;
  }

  /**
   * Returns paginated COD financial reconciliation records.
   *
   * Reconciles delivered COD orders against actual collections with deterministic
   * sorting, discrepancy classification, and complete attribution without N+1.
   * Authoritative delivery timestamp is strictly `lda.delivered_at`.
   */
  async findCodReconciliationRecords(
    filters: CodReconciliationFilters,
    tx?: DeliveryTransactionClient,
  ): Promise<{
    items: CodReconciliationRecordItem[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const client = tx ?? this.prisma;
    const conditions = this.buildCodReconciliationConditions(filters);
    const whereClause =
      conditions.length > 0
        ? Prisma.join(conditions, ' AND ')
        : Prisma.sql`true`;

    const page = filters.page && filters.page > 0 ? filters.page : 1;
    const limit = filters.limit && filters.limit > 0 ? filters.limit : 20;
    const skip = (page - 1) * limit;

    const sortOrder = filters.sortOrder === 'asc' ? 'ASC' : 'DESC';
    let orderClause = Prisma.sql`ORDER BY q.collected_at ${Prisma.raw(sortOrder)} NULLS LAST, q.order_id DESC`;

    if (filters.sortBy === 'collectedAmount') {
      orderClause = Prisma.sql`ORDER BY q.collected_amount ${Prisma.raw(sortOrder)} NULLS LAST, q.order_id DESC`;
    } else if (filters.sortBy === 'currency') {
      orderClause = Prisma.sql`ORDER BY q.currency ${Prisma.raw(sortOrder)}, q.order_id DESC`;
    } else if (filters.sortBy === 'id') {
      orderClause = Prisma.sql`ORDER BY q.order_id ${Prisma.raw(sortOrder)}`;
    } else if (filters.sortBy === 'orderNumber') {
      orderClause = Prisma.sql`ORDER BY q.order_number ${Prisma.raw(sortOrder)}, q.order_id DESC`;
    } else if (filters.sortBy === 'collectedAt') {
      orderClause = Prisma.sql`ORDER BY q.collected_at ${Prisma.raw(sortOrder)} NULLS LAST, q.order_id DESC`;
    } else if (
      filters.sortBy === 'deliveryDate' ||
      filters.sortBy === 'deliveredAt'
    ) {
      orderClause = Prisma.sql`ORDER BY q.delivered_at ${Prisma.raw(sortOrder)} NULLS LAST, q.order_id DESC`;
    }

    const countRows = await client.$queryRaw<Array<{ count: bigint | number }>>`
      WITH latest_delivered_assignment AS (
        SELECT DISTINCT ON (da."order_id")
          da."order_id",
          da."id" AS assignment_id,
          da."delivery_staff_id",
          da."delivered_at",
          da."assigned_at",
          da."status"
        FROM "delivery_assignments" da
        WHERE da."status" = 'DELIVERED'
        ORDER BY da."order_id", da."assigned_at" DESC, da."id" DESC
      ),
      qualifying_orders AS (
        SELECT
          o."id" AS order_id,
          o."order_number",
          o."status" AS order_status,
          o."payment_method",
          o."total_amount",
          o."currency",
          lda."delivery_staff_id",
          lda."delivered_at",
          cc."id" AS collection_id,
          cc."amount" AS collected_amount,
          cc."currency" AS collection_currency,
          cc."collected_at",
          cc."collected_by_id"
        FROM "orders" o
        LEFT JOIN latest_delivered_assignment lda ON lda."order_id" = o."id"
        LEFT JOIN "cod_collections" cc ON cc."order_id" = o."id"
        WHERE ${whereClause}
      )
      SELECT count(*) AS count FROM qualifying_orders
    `;
    const total = Number(countRows[0]?.count ?? 0);

    const rows = await client.$queryRaw<
      Array<{
        order_id: string;
        order_number: string | null;
        order_status: string | null;
        payment_method: string | null;
        total_amount: Prisma.Decimal | string;
        currency: string;
        delivery_staff_id: string | null;
        delivered_at: Date | null;
        collection_id: string | null;
        collected_amount: Prisma.Decimal | string | null;
        collection_currency: string | null;
        collected_at: Date | null;
        collected_by_id: string | null;
        collector_first_name: string | null;
        collector_last_name: string | null;
        collector_email: string | null;
        delivery_first_name: string | null;
        delivery_last_name: string | null;
        delivery_email: string | null;
        discrepancy_type: CodReconciliationDiscrepancyType | null;
      }>
    >`
      WITH latest_delivered_assignment AS (
        SELECT DISTINCT ON (da."order_id")
          da."order_id",
          da."id" AS assignment_id,
          da."delivery_staff_id",
          da."delivered_at",
          da."assigned_at",
          da."status"
        FROM "delivery_assignments" da
        WHERE da."status" = 'DELIVERED'
        ORDER BY da."order_id", da."assigned_at" DESC, da."id" DESC
      ),
      qualifying_orders AS (
        SELECT
          o."id" AS order_id,
          o."order_number",
          o."status" AS order_status,
          o."payment_method",
          o."total_amount",
          o."currency",
          lda."delivery_staff_id",
          lda."delivered_at",
          cc."id" AS collection_id,
          cc."amount" AS collected_amount,
          cc."currency" AS collection_currency,
          cc."collected_at",
          cc."collected_by_id",
          u_col."first_name" AS collector_first_name,
          u_col."last_name" AS collector_last_name,
          u_col."email" AS collector_email,
          u_del."first_name" AS delivery_first_name,
          u_del."last_name" AS delivery_last_name,
          u_del."email" AS delivery_email,
          CASE
            WHEN cc."id" IS NULL THEN 'missing-collection'
            WHEN cc."currency" <> o."currency" THEN 'currency-mismatch'
            WHEN cc."amount" <> o."total_amount" THEN 'amount-mismatch'
            ELSE NULL
          END AS discrepancy_type
        FROM "orders" o
        LEFT JOIN latest_delivered_assignment lda ON lda."order_id" = o."id"
        LEFT JOIN "cod_collections" cc ON cc."order_id" = o."id"
        LEFT JOIN "users" u_col ON u_col."id" = cc."collected_by_id"
        LEFT JOIN "users" u_del ON u_del."id" = lda."delivery_staff_id"
        WHERE ${whereClause}
      )
      SELECT *
      FROM qualifying_orders q
      ${orderClause}
      LIMIT ${limit} OFFSET ${skip}
    `;

    return {
      items: rows.map((r) => ({
        orderId: r.order_id,
        orderNumber: r.order_number,
        orderStatus: r.order_status,
        paymentMethod: r.payment_method,
        totalAmount: new Prisma.Decimal(r.total_amount),
        expectedAmount: new Prisma.Decimal(r.total_amount),
        currency: r.currency,
        collectionCurrency: r.collection_currency,
        collectedAmount:
          r.collected_amount !== null && r.collected_amount !== undefined
            ? new Prisma.Decimal(r.collected_amount)
            : null,
        collectionId: r.collection_id,
        collectedAt: r.collected_at,
        collectedById: r.collected_by_id,
        collectedBy: r.collected_by_id
          ? {
              id: r.collected_by_id,
              firstName: r.collector_first_name ?? '',
              lastName: r.collector_last_name ?? '',
              email: r.collector_email ?? '',
            }
          : null,
        deliveryStaffId: r.delivery_staff_id,
        deliveryStaff: r.delivery_staff_id
          ? {
              id: r.delivery_staff_id,
              firstName: r.delivery_first_name ?? '',
              lastName: r.delivery_last_name ?? '',
              email: r.delivery_email ?? '',
            }
          : null,
        deliveredAt: r.delivered_at,
        discrepancy: r.discrepancy_type !== null,
        discrepancyType: r.discrepancy_type,
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Aggregates COD reconciliation globally.
   *
   * Computes collected, expected, and outstanding amounts grouped strictly by
   * currency, discrepancy count, first/last collection timestamps, and breakdown
   * sections.
   *
   * When order currency differs from collection currency:
   * - Expected amount is reported under the order's currency.
   * - Collected amount is reported under the collection's currency.
   * - Outstanding amount under the order's currency is not reduced by a foreign collection.
   * - Currencies are never mixed or silently converted.
   */
  async summarizeCodReconciliation(
    filters: CodReconciliationFilters,
    tx?: DeliveryTransactionClient,
  ): Promise<CodReconciliationSummaryResult> {
    const client = tx ?? this.prisma;
    const conditions = this.buildCodReconciliationConditions(filters);
    const whereClause =
      conditions.length > 0
        ? Prisma.join(conditions, ' AND ')
        : Prisma.sql`true`;

    const [currencyRows, aggRows, periodBreakdown, staffBreakdown] =
      await Promise.all([
        client.$queryRaw<
          Array<{
            currency: string;
            expected_amount: Prisma.Decimal | string;
            collected_amount: Prisma.Decimal | string;
            outstanding_amount: Prisma.Decimal | string;
            count: unknown;
          }>
        >`
          WITH latest_delivered_assignment AS (
            SELECT DISTINCT ON (da."order_id")
              da."order_id",
              da."delivery_staff_id",
              da."delivered_at",
              da."assigned_at",
              da."status"
            FROM "delivery_assignments" da
            WHERE da."status" = 'DELIVERED'
            ORDER BY da."order_id", da."assigned_at" DESC, da."id" DESC
          ),
          qualifying_orders AS (
            SELECT
              o."id" AS order_id,
              o."total_amount",
              o."currency" AS order_currency,
              lda."delivered_at",
              cc."id" AS collection_id,
              cc."amount" AS collected_amount,
              cc."currency" AS collection_currency,
              cc."collected_at"
            FROM "orders" o
            LEFT JOIN latest_delivered_assignment lda ON lda."order_id" = o."id"
            LEFT JOIN "cod_collections" cc ON cc."order_id" = o."id"
            WHERE ${whereClause}
          ),
          order_totals AS (
            SELECT
              order_currency AS currency,
              SUM(total_amount) AS expected_amount,
              SUM(
                CASE
                  WHEN collection_id IS NULL OR collection_currency <> order_currency
                  THEN total_amount
                  WHEN collected_amount < total_amount
                  THEN (total_amount - collected_amount)
                  ELSE 0
                END
              ) AS outstanding_amount
            FROM qualifying_orders
            GROUP BY order_currency
          ),
          collection_totals AS (
            SELECT
              collection_currency AS currency,
              SUM(collected_amount) AS collected_amount,
              COUNT(collection_id) AS collection_count
            FROM qualifying_orders
            WHERE collection_id IS NOT NULL AND collection_currency IS NOT NULL
            GROUP BY collection_currency
          )
          SELECT
            COALESCE(o.currency, c.currency) AS currency,
            COALESCE(o.expected_amount, 0) AS expected_amount,
            COALESCE(c.collected_amount, 0) AS collected_amount,
            COALESCE(o.outstanding_amount, 0) AS outstanding_amount,
            COALESCE(c.collection_count, 0) AS count
          FROM order_totals o
          FULL OUTER JOIN collection_totals c ON o.currency = c.currency
          ORDER BY currency ASC
        `,
        client.$queryRaw<
          Array<{
            total_collections: unknown;
            discrepancy_count: unknown;
            first_collection_at: Date | null;
            last_collection_at: Date | null;
          }>
        >`
          WITH latest_delivered_assignment AS (
            SELECT DISTINCT ON (da."order_id")
              da."order_id",
              da."delivery_staff_id",
              da."delivered_at",
              da."assigned_at",
              da."status"
            FROM "delivery_assignments" da
            WHERE da."status" = 'DELIVERED'
            ORDER BY da."order_id", da."assigned_at" DESC, da."id" DESC
          ),
          qualifying_orders AS (
            SELECT
              o."id" AS order_id,
              o."total_amount",
              o."currency",
              lda."delivered_at",
              cc."id" AS collection_id,
              cc."amount" AS collected_amount,
              cc."currency" AS collection_currency,
              cc."collected_at",
              CASE
                WHEN cc."id" IS NULL THEN 'missing-collection'
                WHEN cc."currency" <> o."currency" THEN 'currency-mismatch'
                WHEN cc."amount" <> o."total_amount" THEN 'amount-mismatch'
                ELSE NULL
              END AS discrepancy_type
            FROM "orders" o
            LEFT JOIN latest_delivered_assignment lda ON lda."order_id" = o."id"
            LEFT JOIN "cod_collections" cc ON cc."order_id" = o."id"
            WHERE ${whereClause}
          )
          SELECT
            COUNT(collection_id) AS total_collections,
            COUNT(CASE WHEN discrepancy_type IS NOT NULL THEN 1 END) AS discrepancy_count,
            MIN(collected_at) AS first_collection_at,
            MAX(collected_at) AS last_collection_at
          FROM qualifying_orders
        `,
        this.summarizeCodReconciliationByPeriod(filters, tx),
        this.summarizeCodReconciliationByStaff(filters, tx),
      ]);

    const aggRow = aggRows[0];
    const totalsByCurrency: CodReconciliationCurrencyTotal[] = currencyRows.map(
      (r) => ({
        currency: r.currency,
        collectedAmount: new Prisma.Decimal(r.collected_amount ?? 0),
        expectedAmount: new Prisma.Decimal(r.expected_amount ?? 0),
        outstandingAmount: new Prisma.Decimal(r.outstanding_amount ?? 0),
        count: Number(r.count),
      }),
    );

    return {
      totalCollections: Number(aggRow?.total_collections ?? 0),
      totalsByCurrency,
      expectedAmountByCurrency: totalsByCurrency.map((t) => ({
        currency: t.currency,
        totalAmount: t.expectedAmount,
      })),
      outstandingAmountByCurrency: totalsByCurrency.map((t) => ({
        currency: t.currency,
        totalAmount: t.outstandingAmount,
      })),
      collectionCount: Number(aggRow?.total_collections ?? 0),
      discrepancyCount: Number(aggRow?.discrepancy_count ?? 0),
      firstCollectionAt: aggRow?.first_collection_at ?? null,
      lastCollectionAt: aggRow?.last_collection_at ?? null,
      periodBreakdown,
      staffBreakdown,
    };
  }

  /**
   * Returns delivered COD orders that have no recorded collection.
   * Delivery timestamp is strictly `lda.delivered_at`.
   */
  async findUncollectedDeliveredCodOrders(
    filters: CodReconciliationFilters,
    tx?: DeliveryTransactionClient,
  ): Promise<{
    items: UncollectedDeliveredCodOrderItem[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const client = tx ?? this.prisma;
    const conditions = this.buildUncollectedCodConditions(filters);
    const whereClause =
      conditions.length > 0
        ? Prisma.join(conditions, ' AND ')
        : Prisma.sql`true`;

    const page = filters.page && filters.page > 0 ? filters.page : 1;
    const limit = filters.limit && filters.limit > 0 ? filters.limit : 20;
    const skip = (page - 1) * limit;

    const countRows = await client.$queryRaw<Array<{ count: bigint | number }>>`
      WITH latest_delivered_assignment AS (
        SELECT DISTINCT ON (da."order_id")
          da."order_id",
          da."id" AS assignment_id,
          da."delivery_staff_id",
          da."delivered_at",
          da."assigned_at",
          da."status"
        FROM "delivery_assignments" da
        WHERE da."status" = 'DELIVERED'
        ORDER BY da."order_id", da."assigned_at" DESC, da."id" DESC
      ),
      uncollected_orders AS (
        SELECT
          o."id" AS order_id,
          o."order_number",
          o."status" AS order_status,
          o."payment_method",
          o."total_amount",
          o."currency",
          lda."delivery_staff_id",
          lda."delivered_at"
        FROM "orders" o
        LEFT JOIN latest_delivered_assignment lda ON lda."order_id" = o."id"
        WHERE ${whereClause}
      )
      SELECT count(*) AS count FROM uncollected_orders
    `;
    const total = Number(countRows[0]?.count ?? 0);

    const rows = await client.$queryRaw<
      Array<{
        order_id: string;
        order_number: string;
        order_status: string;
        total_amount: Prisma.Decimal | string;
        currency: string;
        delivery_staff_id: string | null;
        delivered_at: Date | null;
        staff_first_name: string | null;
        staff_last_name: string | null;
        staff_email: string | null;
      }>
    >`
      WITH latest_delivered_assignment AS (
        SELECT DISTINCT ON (da."order_id")
          da."order_id",
          da."id" AS assignment_id,
          da."delivery_staff_id",
          da."delivered_at",
          da."assigned_at",
          da."status"
        FROM "delivery_assignments" da
        WHERE da."status" = 'DELIVERED'
        ORDER BY da."order_id", da."assigned_at" DESC, da."id" DESC
      ),
      uncollected_orders AS (
        SELECT
          o."id" AS order_id,
          o."order_number",
          o."status" AS order_status,
          o."payment_method",
          o."total_amount",
          o."currency",
          lda."delivery_staff_id",
          lda."delivered_at",
          u."first_name" AS staff_first_name,
          u."last_name" AS staff_last_name,
          u."email" AS staff_email
        FROM "orders" o
        LEFT JOIN latest_delivered_assignment lda ON lda."order_id" = o."id"
        LEFT JOIN "users" u ON u."id" = lda."delivery_staff_id"
        WHERE ${whereClause}
      )
      SELECT *
      FROM uncollected_orders
      ORDER BY delivered_at DESC NULLS LAST, order_id DESC
      LIMIT ${limit} OFFSET ${skip}
    `;

    return {
      items: rows.map((r) => ({
        orderId: r.order_id,
        orderNumber: r.order_number,
        orderStatus: r.order_status,
        totalAmount: new Prisma.Decimal(r.total_amount),
        expectedAmount: new Prisma.Decimal(r.total_amount),
        currency: r.currency,
        deliveryStaffId: r.delivery_staff_id,
        deliveryStaff: r.delivery_staff_id
          ? {
              id: r.delivery_staff_id,
              firstName: r.staff_first_name ?? '',
              lastName: r.staff_last_name ?? '',
              email: r.staff_email ?? '',
            }
          : null,
        deliveredAt: r.delivered_at,
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Returns reconciliation discrepancy rows (missing collection, amount mismatch,
   * currency mismatch).
   * Delivery timestamp is strictly `lda.delivered_at`.
   */
  async findCodReconciliationDiscrepancies(
    filters: CodReconciliationFilters,
    tx?: DeliveryTransactionClient,
  ): Promise<{
    items: CodReconciliationDiscrepancyItem[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const client = tx ?? this.prisma;
    const conditions = this.buildCodReconciliationConditions(filters);
    const whereClause =
      conditions.length > 0
        ? Prisma.join(conditions, ' AND ')
        : Prisma.sql`true`;

    const page = filters.page && filters.page > 0 ? filters.page : 1;
    const limit = filters.limit && filters.limit > 0 ? filters.limit : 20;
    const skip = (page - 1) * limit;

    const countRows = await client.$queryRaw<Array<{ count: bigint | number }>>`
      WITH latest_delivered_assignment AS (
        SELECT DISTINCT ON (da."order_id")
          da."order_id",
          da."id" AS assignment_id,
          da."delivery_staff_id",
          da."delivered_at",
          da."assigned_at",
          da."status"
        FROM "delivery_assignments" da
        WHERE da."status" = 'DELIVERED'
        ORDER BY da."order_id", da."assigned_at" DESC, da."id" DESC
      ),
      qualifying_orders AS (
        SELECT
          o."id" AS order_id,
          o."order_number",
          o."status" AS order_status,
          o."payment_method",
          o."total_amount",
          o."currency",
          lda."delivery_staff_id",
          lda."delivered_at",
          cc."id" AS collection_id,
          cc."amount" AS collected_amount,
          cc."currency" AS collection_currency,
          cc."collected_at",
          cc."collected_by_id",
          CASE
            WHEN cc."id" IS NULL THEN 'missing-collection'
            WHEN cc."currency" <> o."currency" THEN 'currency-mismatch'
            WHEN cc."amount" <> o."total_amount" THEN 'amount-mismatch'
            ELSE NULL
          END AS discrepancy_type
        FROM "orders" o
        LEFT JOIN latest_delivered_assignment lda ON lda."order_id" = o."id"
        LEFT JOIN "cod_collections" cc ON cc."order_id" = o."id"
        WHERE ${whereClause}
      )
      SELECT count(*) AS count FROM qualifying_orders WHERE discrepancy_type IS NOT NULL
    `;
    const total = Number(countRows[0]?.count ?? 0);

    const rows = await client.$queryRaw<
      Array<{
        order_id: string;
        order_number: string | null;
        order_status: string | null;
        total_amount: Prisma.Decimal | string;
        collected_amount: Prisma.Decimal | string | null;
        currency: string;
        collection_currency: string | null;
        collection_id: string | null;
        delivered_at: Date | null;
        discrepancy_type: CodReconciliationDiscrepancyType;
      }>
    >`
      WITH latest_delivered_assignment AS (
        SELECT DISTINCT ON (da."order_id")
          da."order_id",
          da."id" AS assignment_id,
          da."delivery_staff_id",
          da."delivered_at",
          da."assigned_at",
          da."status"
        FROM "delivery_assignments" da
        WHERE da."status" = 'DELIVERED'
        ORDER BY da."order_id", da."assigned_at" DESC, da."id" DESC
      ),
      qualifying_orders AS (
        SELECT
          o."id" AS order_id,
          o."order_number",
          o."status" AS order_status,
          o."payment_method",
          o."total_amount",
          o."currency",
          lda."delivery_staff_id",
          lda."delivered_at",
          cc."id" AS collection_id,
          cc."amount" AS collected_amount,
          cc."currency" AS collection_currency,
          cc."collected_at",
          cc."collected_by_id",
          CASE
            WHEN cc."id" IS NULL THEN 'missing-collection'
            WHEN cc."currency" <> o."currency" THEN 'currency-mismatch'
            WHEN cc."amount" <> o."total_amount" THEN 'amount-mismatch'
            ELSE NULL
          END AS discrepancy_type
        FROM "orders" o
        LEFT JOIN latest_delivered_assignment lda ON lda."order_id" = o."id"
        LEFT JOIN "cod_collections" cc ON cc."order_id" = o."id"
        WHERE ${whereClause}
      )
      SELECT
        order_id,
        order_number,
        order_status,
        total_amount,
        collected_amount,
        currency,
        collection_currency,
        collection_id,
        delivered_at,
        discrepancy_type
      FROM qualifying_orders
      WHERE discrepancy_type IS NOT NULL
      ORDER BY delivered_at DESC NULLS LAST, order_id DESC
      LIMIT ${limit} OFFSET ${skip}
    `;

    return {
      items: rows.map((r) => ({
        orderId: r.order_id,
        orderNumber: r.order_number,
        orderStatus: r.order_status,
        discrepancyType: r.discrepancy_type,
        totalAmount: new Prisma.Decimal(r.total_amount),
        expectedAmount: new Prisma.Decimal(r.total_amount),
        collectedAmount:
          r.collected_amount !== null && r.collected_amount !== undefined
            ? new Prisma.Decimal(r.collected_amount)
            : null,
        actualAmount:
          r.collected_amount !== null && r.collected_amount !== undefined
            ? new Prisma.Decimal(r.collected_amount)
            : null,
        currency: r.currency,
        collectionCurrency: r.collection_currency,
        collectionId: r.collection_id,
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Aggregates COD reconciliation by staff member and currency.
   *
   * Attribution:
   * - Collected amounts belong to `cod_collections.collected_by_id`.
   * - Outstanding amounts belong to the courier of the latest DELIVERED assignment.
   * - Currencies are strictly separated; foreign currency collections do not reduce
   *   the responsible staff's expected amount.
   */
  async summarizeCodReconciliationByStaff(
    filters: CodReconciliationFilters,
    tx?: DeliveryTransactionClient,
  ): Promise<CodReconciliationStaffBreakdown[]> {
    const client = tx ?? this.prisma;
    const conditions = this.buildCodReconciliationConditions(filters);
    const whereClause =
      conditions.length > 0
        ? Prisma.join(conditions, ' AND ')
        : Prisma.sql`true`;

    const staffFilterClause = filters.staffId
      ? Prisma.sql`AND COALESCE(d.staff_id, c.staff_id) = ${filters.staffId}::uuid`
      : Prisma.empty;

    const rows = await client.$queryRaw<
      Array<{
        staff_id: string;
        currency: string;
        expected_amount: Prisma.Decimal | string;
        collected_amount: Prisma.Decimal | string;
        outstanding_amount: Prisma.Decimal | string;
        count: unknown;
      }>
    >`
      WITH latest_delivered_assignment AS (
        SELECT DISTINCT ON (da."order_id")
          da."order_id",
          da."delivery_staff_id",
          da."delivered_at",
          da."assigned_at",
          da."status"
        FROM "delivery_assignments" da
        WHERE da."status" = 'DELIVERED'
        ORDER BY da."order_id", da."assigned_at" DESC, da."id" DESC
      ),
      qualifying_orders AS (
        SELECT
          o."id" AS order_id,
          o."total_amount",
          o."currency" AS order_currency,
          lda."delivery_staff_id",
          lda."delivered_at",
          cc."id" AS collection_id,
          cc."amount" AS collected_amount,
          cc."currency" AS collection_currency,
          cc."collected_by_id"
        FROM "orders" o
        LEFT JOIN latest_delivered_assignment lda ON lda."order_id" = o."id"
        LEFT JOIN "cod_collections" cc ON cc."order_id" = o."id"
        WHERE ${whereClause}
      ),
      delivery_totals AS (
        SELECT
          delivery_staff_id AS staff_id,
          order_currency AS currency,
          SUM(total_amount) AS expected_amount,
          SUM(
            CASE
              WHEN collection_id IS NULL OR collection_currency <> order_currency
              THEN total_amount
              WHEN collected_amount < total_amount
              THEN (total_amount - collected_amount)
              ELSE 0
            END
          ) AS outstanding_amount
        FROM qualifying_orders
        WHERE delivery_staff_id IS NOT NULL
        GROUP BY delivery_staff_id, order_currency
      ),
      collection_totals AS (
        SELECT
          collected_by_id AS staff_id,
          collection_currency AS currency,
          SUM(collected_amount) AS collected_amount,
          COUNT(collection_id) AS collection_count
        FROM qualifying_orders
        WHERE collection_id IS NOT NULL AND collected_by_id IS NOT NULL
        GROUP BY collected_by_id, collection_currency
      )
      SELECT
        COALESCE(d.staff_id, c.staff_id) AS staff_id,
        COALESCE(d.currency, c.currency) AS currency,
        COALESCE(d.expected_amount, 0) AS expected_amount,
        COALESCE(c.collected_amount, 0) AS collected_amount,
        COALESCE(d.outstanding_amount, 0) AS outstanding_amount,
        COALESCE(c.collection_count, 0) AS count
      FROM delivery_totals d
      FULL OUTER JOIN collection_totals c
        ON d.staff_id = c.staff_id AND d.currency = c.currency
      WHERE COALESCE(d.staff_id, c.staff_id) IS NOT NULL
      ${staffFilterClause}
      ORDER BY staff_id ASC, currency ASC
    `;

    const staffIds = [...new Set(rows.map((r) => r.staff_id))];
    const staffUsers =
      staffIds.length > 0
        ? await client.user.findMany({
            where: { id: { in: staffIds } },
            select: { id: true, firstName: true, lastName: true, email: true },
          })
        : [];
    const staffMap = new Map(staffUsers.map((u) => [u.id, u]));

    return rows.map((r) => ({
      staffId: r.staff_id,
      staff: staffMap.get(r.staff_id) ?? {
        id: r.staff_id,
        firstName: 'Unknown',
        lastName: 'Staff',
        email: '',
      },
      currency: r.currency,
      expectedAmount: new Prisma.Decimal(r.expected_amount ?? 0),
      collectedAmount: new Prisma.Decimal(r.collected_amount ?? 0),
      outstandingAmount: new Prisma.Decimal(r.outstanding_amount ?? 0),
      count: Number(r.count),
    }));
  }

  /**
   * Aggregates COD reconciliation by period (daily, weekly, monthly in UTC)
   * and currency.
   *
   * Only orders with an authoritative `lda.delivered_at` timestamp are bucketed
   * into calendar periods. Currencies are strictly separated via FULL OUTER JOIN.
   */
  async summarizeCodReconciliationByPeriod(
    filters: CodReconciliationFilters,
    tx?: DeliveryTransactionClient,
  ): Promise<CodReconciliationPeriodBreakdown[]> {
    const client = tx ?? this.prisma;
    const conditions = this.buildCodReconciliationConditions(filters);
    const whereClause =
      conditions.length > 0
        ? Prisma.join(conditions, ' AND ')
        : Prisma.sql`true`;

    const periodExpr =
      filters.period === 'weekly'
        ? "to_char(date_trunc('week', lda.\"delivered_at\" AT TIME ZONE 'UTC'), 'YYYY-MM-DD')"
        : filters.period === 'monthly'
          ? "to_char(date_trunc('month', lda.\"delivered_at\" AT TIME ZONE 'UTC'), 'YYYY-MM')"
          : "to_char(lda.\"delivered_at\" AT TIME ZONE 'UTC', 'YYYY-MM-DD')";

    const rows = await client.$queryRaw<
      Array<{
        period: string;
        currency: string;
        expected_amount: Prisma.Decimal | string;
        collected_amount: Prisma.Decimal | string;
        outstanding_amount: Prisma.Decimal | string;
        count: unknown;
      }>
    >`
      WITH latest_delivered_assignment AS (
        SELECT DISTINCT ON (da."order_id")
          da."order_id",
          da."delivery_staff_id",
          da."delivered_at",
          da."assigned_at",
          da."status"
        FROM "delivery_assignments" da
        WHERE da."status" = 'DELIVERED'
        ORDER BY da."order_id", da."assigned_at" DESC, da."id" DESC
      ),
      qualifying_orders AS (
        SELECT
          o."id" AS order_id,
          o."total_amount",
          o."currency" AS order_currency,
          ${Prisma.raw(periodExpr)} AS period,
          lda."delivered_at",
          cc."id" AS collection_id,
          cc."amount" AS collected_amount,
          cc."currency" AS collection_currency
        FROM "orders" o
        LEFT JOIN latest_delivered_assignment lda ON lda."order_id" = o."id"
        LEFT JOIN "cod_collections" cc ON cc."order_id" = o."id"
        WHERE ${whereClause}
          AND lda."delivered_at" IS NOT NULL
      ),
      period_order_totals AS (
        SELECT
          period,
          order_currency AS currency,
          SUM(total_amount) AS expected_amount,
          SUM(
            CASE
              WHEN collection_id IS NULL OR collection_currency <> order_currency
              THEN total_amount
              WHEN collected_amount < total_amount
              THEN (total_amount - collected_amount)
              ELSE 0
            END
          ) AS outstanding_amount
        FROM qualifying_orders
        GROUP BY period, order_currency
      ),
      period_collection_totals AS (
        SELECT
          period,
          collection_currency AS currency,
          SUM(collected_amount) AS collected_amount,
          COUNT(collection_id) AS collection_count
        FROM qualifying_orders
        WHERE collection_id IS NOT NULL AND collection_currency IS NOT NULL
        GROUP BY period, collection_currency
      )
      SELECT
        COALESCE(o.period, c.period) AS period,
        COALESCE(o.currency, c.currency) AS currency,
        COALESCE(o.expected_amount, 0) AS expected_amount,
        COALESCE(c.collected_amount, 0) AS collected_amount,
        COALESCE(o.outstanding_amount, 0) AS outstanding_amount,
        COALESCE(c.collection_count, 0) AS count
      FROM period_order_totals o
      FULL OUTER JOIN period_collection_totals c
        ON o.period = c.period AND o.currency = c.currency
      ORDER BY 1 ASC, 2 ASC
    `;

    return rows.map((r) => ({
      period: r.period,
      currency: r.currency,
      expectedAmount: new Prisma.Decimal(r.expected_amount ?? 0),
      collectedAmount: new Prisma.Decimal(r.collected_amount ?? 0),
      outstandingAmount: new Prisma.Decimal(r.outstanding_amount ?? 0),
      count: Number(r.count),
    }));
  }
}
