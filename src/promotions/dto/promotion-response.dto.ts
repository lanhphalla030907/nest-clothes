import { toMoneyString } from '../../common/utils/money.js';
import type { Promotion } from '../../generated/prisma/client.js';

/**
 * The administrative shape of one promotion.
 *
 * Money and percentages cross the API boundary as fixed strings for the same
 * reason every other amount does: a JSON number can lose a decimal. `percentOff`
 * is not money, but it is normalised to two decimals so `10` and `10.00` do not
 * read as two different rules.
 */
export class PromotionResponseDto {
  id: string;
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
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;

  static fromEntity(promotion: Promotion): PromotionResponseDto {
    const dto = new PromotionResponseDto();

    dto.id = promotion.id;
    dto.code = promotion.code;
    dto.name = promotion.name;
    dto.description = promotion.description;
    dto.kind = promotion.kind;
    dto.discountType = promotion.discountType;
    dto.percentOff =
      promotion.percentOff === null ? null : promotion.percentOff.toFixed(2);
    dto.amountOff =
      promotion.amountOff === null ? null : toMoneyString(promotion.amountOff);
    dto.minSubtotal = toMoneyString(promotion.minSubtotal);
    dto.maxDiscount =
      promotion.maxDiscount === null
        ? null
        : toMoneyString(promotion.maxDiscount);
    dto.startsAt = promotion.startsAt;
    dto.endsAt = promotion.endsAt;
    dto.isActive = promotion.isActive;
    dto.usageLimitTotal = promotion.usageLimitTotal;
    dto.usageLimitPerUser = promotion.usageLimitPerUser;
    dto.priority = promotion.priority;
    dto.archivedAt = promotion.archivedAt;
    dto.createdAt = promotion.createdAt;
    dto.updatedAt = promotion.updatedAt;
    return dto;
  }
}
