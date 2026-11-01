import { toMoneyString } from '../../common/utils/money.js';

/**
 * One row of the administrative COD collection listing.
 *
 * `amount` is a fixed two-decimal string so the figure cannot drift between the
 * database and the client. Only the delivery staff member's name is exposed —
 * no customer PII.
 */
export class AdminCodCollectionListRowDto {
  collectionId: string;
  orderId: string;
  orderNumber: string | null;
  amount: string;
  currency: string;
  collectedAt: Date;
  collectedById: string;
  collectedBy: { id: string; firstName: string; lastName: string; email: string } | null;

  static fromEntity(entity: {
    id: string;
    orderId: string;
    order: { orderNumber: string | null } | null;
    amount: unknown;
    currency: string;
    collectedAt: Date;
    collectedById: string;
    collectedBy: {
      id: string;
      firstName: string;
      lastName: string;
      email: string;
    } | null;
  }): AdminCodCollectionListRowDto {
    const dto = new AdminCodCollectionListRowDto();
    dto.collectionId = entity.id;
    dto.orderId = entity.orderId;
    dto.orderNumber = entity.order?.orderNumber ?? null;
    dto.amount = toMoneyString(entity.amount);
    dto.currency = entity.currency;
    dto.collectedAt = entity.collectedAt;
    dto.collectedById = entity.collectedById;
    dto.collectedBy = entity.collectedBy;
    return dto;
  }
}

/**
 * The administrative COD collection listing response.
 *
 * `items` is the page and `pagination.total` describes the same filtered result
 * set the page was drawn from.
 */
export class AdminCodCollectionsListResponseDto {
  items: AdminCodCollectionListRowDto[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };

  static fromResult(input: {
    items: AdminCodCollectionListRowDto[];
    total: number;
    page: number;
    limit: number;
  }): AdminCodCollectionsListResponseDto {
    const dto = new AdminCodCollectionsListResponseDto();
    dto.items = input.items;
    dto.pagination = {
      page: input.page,
      limit: input.limit,
      total: input.total,
      totalPages: Math.ceil(input.total / input.limit),
    };
    return dto;
  }
}
