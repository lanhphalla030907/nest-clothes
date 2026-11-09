import { PromotionPaginationDto } from './promotion-list-response.dto.js';
import { PromotionUsageResponseDto } from './promotion-usage-response.dto.js';
import type { PromotionUsageRow } from '../repositories/promotions.repository.js';

/** One page of a promotion's usage history. */
export class PromotionUsageListResponseDto {
  items: PromotionUsageResponseDto[];
  pagination: PromotionPaginationDto;

  static fromResult(
    result: { items: PromotionUsageRow[]; total: number },
    page: number,
    limit: number,
  ): PromotionUsageListResponseDto {
    const dto = new PromotionUsageListResponseDto();

    dto.items = result.items.map((row) =>
      PromotionUsageResponseDto.fromRow(row),
    );
    dto.pagination = {
      page,
      limit,
      total: result.total,
      totalPages: Math.ceil(result.total / limit),
    };
    return dto;
  }
}
