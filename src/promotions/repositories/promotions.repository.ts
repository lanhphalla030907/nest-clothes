import { Injectable } from '@nestjs/common';
import { Prisma, type Promotion } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * A promotion row as the service writes it.
 *
 * Money and percentage columns are typed as strings even though Prisma accepts
 * `Decimal` too. The service has already normalised them to the exact textual
 * form the column stores, so passing the string through avoids a second
 * conversion that could round differently.
 */
export interface CreatePromotionData {
  code: string | null;
  name: string;
  description: string | null;
  kind: string;
  discountType: string;
  percentOff: string | null;
  amountOff: string | null;
  minSubtotal: string;
  maxDiscount: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  isActive: boolean;
  usageLimitTotal: number | null;
  usageLimitPerUser: number | null;
  priority: number;
}

export type UpdatePromotionData = Partial<CreatePromotionData> & {
  archivedAt?: Date | null;
};

/**
 * One immutable usage-ledger row, ready to insert.
 *
 * All descriptive columns are snapshots taken when checkout evaluated the
 * promotion, so a later edit to the promotion cannot rewrite what an order was
 * actually discounted by. `discountAmount` and `subtotalAtUse` are the same
 * fixed two-decimal strings the evaluator produced.
 */
export interface CreatePromotionUsageData {
  promotionId: string;
  orderId: string;
  userId: string;
  codeSnapshot: string | null;
  nameSnapshot: string;
  discountType: string;
  percentOff: string | null;
  amountOff: string | null;
  discountAmount: string;
  subtotalAtUse: string;
}

/** Filters the service has already validated and normalised. */
export interface PromotionListFilters {
  page: number;
  limit: number;
  kind?: string;
  discountType?: string;
  isActive?: boolean;
  archived?: boolean;
  search?: string;
}

export interface PromotionUsageListFilters {
  page: number;
  limit: number;
}

const PROMOTION_ORDER_BY: Prisma.PromotionOrderByWithRelationInput[] = [
  { createdAt: 'desc' },
  { id: 'desc' },
];

/**
 * The related rows an administrator needs to understand a usage.
 *
 * Only the customer's name and email are selected — never credentials — and only
 * the order's public identifier, matching the same rule the admin order
 * projections follow.
 */
const PROMOTION_USAGE_INCLUDE = {
  user: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
    },
  },
  order: {
    select: {
      id: true,
      orderNumber: true,
    },
  },
} satisfies Prisma.PromotionUsageInclude;

export type PromotionUsageRow = Prisma.PromotionUsageGetPayload<{
  include: typeof PROMOTION_USAGE_INCLUDE;
}>;

/**
 * The only place in the promotions feature that talks to the database.
 *
 * Every read and write accepts the caller's `Prisma.TransactionClient` (or
 * defaults to the root client). That is what lets checkout evaluate a
 * promotion, count its usages and later consume it inside the one Serializable
 * transaction that creates the order, without the promotions module ever opening
 * a transaction of its own.
 */
@Injectable()
export class PromotionsRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(
    data: CreatePromotionData,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<Promotion> {
    return client.promotion.create({ data });
  }

  findById(
    id: string,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<Promotion | null> {
    return client.promotion.findUnique({ where: { id } });
  }

  findByCode(
    code: string,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<Promotion | null> {
    return client.promotion.findUnique({ where: { code } });
  }

  /**
   * The automatic promotions that could apply to a cart of `subtotal`.
   *
   * The query is deliberately narrower than the rule engine: it pushes the easy
   * predicates into SQL so the evaluator does not load the whole table, then the
   * evaluator re-checks every condition. The second check is not redundant — it
   * is what keeps the rule correct if the query is changed, or if a caller
   * supplies rows from somewhere else in a unit test.
   *
   * `endsAt` is inclusive: a promotion ending at exactly `now` is still valid.
   * The evaluator uses the same comparison.
   */
  findAutomaticCandidates(
    subtotal: string,
    now: Date,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<Promotion[]> {
    return client.promotion.findMany({
      where: {
        kind: 'AUTOMATIC',
        isActive: true,
        archivedAt: null,
        minSubtotal: { lte: subtotal },
        AND: [
          {
            OR: [{ startsAt: null }, { startsAt: { lte: now } }],
          },
          {
            OR: [{ endsAt: null }, { endsAt: { gte: now } }],
          },
        ],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  update(
    id: string,
    data: UpdatePromotionData,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<Promotion> {
    return client.promotion.update({ where: { id }, data });
  }

  /**
   * Writes one ledger row per promotion applied to an order.
   *
   * Called from inside the checkout transaction, immediately after the order row
   * exists. `createMany` is a single statement, so either every applied
   * promotion is recorded or none is. The `(promotion_id, order_id)` unique
   * constraint is the final idempotency backstop: a concurrent replay that
   * somehow reached this point fails and rolls the whole order back rather than
   * double-counting a use.
   */
  createUsages(
    data: CreatePromotionUsageData[],
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<Prisma.BatchPayload> {
    if (data.length === 0) {
      return Promise.resolve({ count: 0 });
    }

    return client.promotionUsage.createMany({ data });
  }

  /**
   * One page of promotions and the total matching the same filters.
   *
   * Both queries receive the same `where` object and run on the same client, so a
   * page and its count cannot describe different result sets.
   */
  async findPage(
    filters: PromotionListFilters,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<{ items: Promotion[]; total: number }> {
    const where = buildPromotionWhere(filters);
    const skip = (filters.page - 1) * filters.limit;

    const [items, total] = await Promise.all([
      client.promotion.findMany({
        where,
        orderBy: PROMOTION_ORDER_BY,
        skip,
        take: filters.limit,
      }),
      client.promotion.count({ where }),
    ]);

    return { items, total };
  }

  /** One page of the usage ledger for a promotion, newest first. */
  async findUsagePage(
    promotionId: string,
    filters: PromotionUsageListFilters,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<{ items: PromotionUsageRow[]; total: number }> {
    const where: Prisma.PromotionUsageWhereInput = { promotionId };
    const skip = (filters.page - 1) * filters.limit;

    const [items, total] = await Promise.all([
      client.promotionUsage.findMany({
        where,
        include: PROMOTION_USAGE_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: filters.limit,
      }),
      client.promotionUsage.count({ where }),
    ]);

    return { items, total };
  }

  /**
   * The global number of orders that have consumed a promotion.
   *
   * Read through the caller's transaction so a checkout that is validating a
   * limit sees the same snapshot as the usage write it is about to make.
   */
  countUsages(
    promotionId: string,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<number> {
    return client.promotionUsage.count({ where: { promotionId } });
  }

  /** The number of orders this one user has already consumed the promotion on. */
  countUsagesForUser(
    promotionId: string,
    userId: string,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<number> {
    return client.promotionUsage.count({
      where: { promotionId, userId },
    });
  }
}

/** Builds the shared `where` for the promotion page and its total. */
function buildPromotionWhere(
  filters: PromotionListFilters,
): Prisma.PromotionWhereInput {
  const where: Prisma.PromotionWhereInput = {};

  if (filters.kind !== undefined) {
    where.kind = filters.kind;
  }

  if (filters.discountType !== undefined) {
    where.discountType = filters.discountType;
  }

  if (filters.isActive !== undefined) {
    where.isActive = filters.isActive;
  }

  if (filters.archived !== undefined) {
    where.archivedAt = filters.archived ? { not: null } : null;
  }

  if (filters.search !== undefined) {
    where.OR = [
      { code: { contains: filters.search, mode: 'insensitive' } },
      { name: { contains: filters.search, mode: 'insensitive' } },
    ];
  }

  return where;
}
