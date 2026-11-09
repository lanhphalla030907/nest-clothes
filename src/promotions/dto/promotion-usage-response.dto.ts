import { toMoneyString } from '../../common/utils/money.js';
import type { PromotionUsageRow } from '../repositories/promotions.repository.js';

/** The customer identity attached to a usage, without any credential fields. */
export class PromotionUsageUserDto {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

/** The order identity attached to a usage. */
export class PromotionUsageOrderDto {
  id: string;
  orderNumber: string;
}

/**
 * One immutable promotion usage.
 *
 * The descriptive values come from the ledger row, not from the live promotion.
 * That is the point of the snapshot: renaming or archiving a promotion must not
 * change what a past order shows.
 */
export class PromotionUsageResponseDto {
  id: string;
  promotionId: string;
  orderId: string;
  orderNumber: string;
  userId: string;
  user: PromotionUsageUserDto;
  order: PromotionUsageOrderDto;
  codeSnapshot: string | null;
  nameSnapshot: string;
  discountType: string;
  percentOff: string | null;
  amountOff: string | null;
  discountAmount: string;
  subtotalAtUse: string;
  createdAt: Date;

  static fromRow(row: PromotionUsageRow): PromotionUsageResponseDto {
    const dto = new PromotionUsageResponseDto();

    dto.id = row.id;
    dto.promotionId = row.promotionId;
    dto.orderId = row.orderId;
    dto.orderNumber = row.order.orderNumber;
    dto.userId = row.userId;
    dto.user = {
      id: row.user.id,
      firstName: row.user.firstName,
      lastName: row.user.lastName,
      email: row.user.email,
    };
    dto.order = {
      id: row.order.id,
      orderNumber: row.order.orderNumber,
    };
    dto.codeSnapshot = row.codeSnapshot;
    dto.nameSnapshot = row.nameSnapshot;
    dto.discountType = row.discountType;
    dto.percentOff = row.percentOff === null ? null : row.percentOff.toFixed(2);
    dto.amountOff =
      row.amountOff === null ? null : toMoneyString(row.amountOff);
    dto.discountAmount = toMoneyString(row.discountAmount);
    dto.subtotalAtUse = toMoneyString(row.subtotalAtUse);
    dto.createdAt = row.createdAt;
    return dto;
  }
}
