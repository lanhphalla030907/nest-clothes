import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';
import {
  DEFAULT_PROMOTION_PAGE_SIZE,
  MAX_PROMOTION_PAGE_SIZE,
} from '../constants/promotion.constants.js';

/** Pagination for one promotion's usage history. */
export class PromotionUsageListQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PROMOTION_PAGE_SIZE)
  limit: number = DEFAULT_PROMOTION_PAGE_SIZE;
}
