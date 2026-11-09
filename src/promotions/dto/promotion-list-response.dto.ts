import type { Promotion } from '../../generated/prisma/client.js';
import { PromotionResponseDto } from './promotion-response.dto.js';

/** Pagination metadata shared with the administrative order listing. */
export class PromotionPaginationDto {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/**
 * One page of promotions.
 *
 * `items` is the page, `pagination.total` is the number of rows matching the same
 * filters, and `totalPages` is zero for an empty result.
 */
export class PromotionListResponseDto {
  items: PromotionResponseDto[];
  pagination: PromotionPaginationDto;

  static fromResult(
    result: { items: Promotion[]; total: number },
    page: number,
    limit: number,
  ): PromotionListResponseDto {
    const dto = new PromotionListResponseDto();

    dto.items = result.items.map((promotion) =>
      PromotionResponseDto.fromEntity(promotion),
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
