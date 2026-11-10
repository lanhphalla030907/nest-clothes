import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  FINANCE_DEFAULT_PAGE_SIZE,
  FINANCE_MAX_PAGE_SIZE,
  FINANCE_PRODUCT_SORT_BY,
  FINANCE_SORT_ORDERS,
  type FinanceProductSortBy,
  type FinanceSortOrder,
} from '../finance.constants.js';
import { FinanceQueryDto } from './finance-query.dto.js';

/** Query contract for `GET /admin/finance/products`. */
export class ProductProfitQueryDto extends FinanceQueryDto {
  /** One-based page number. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  /** Page size, capped so one request cannot ask for the whole catalogue. */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(FINANCE_MAX_PAGE_SIZE)
  limit: number = FINANCE_DEFAULT_PAGE_SIZE;

  @IsOptional()
  @IsIn(FINANCE_PRODUCT_SORT_BY, {
    message: `sortBy must be one of ${FINANCE_PRODUCT_SORT_BY.join(', ')}`,
  })
  sortBy: FinanceProductSortBy = 'revenue';

  @IsOptional()
  @IsIn(FINANCE_SORT_ORDERS, {
    message: `sortOrder must be one of ${FINANCE_SORT_ORDERS.join(', ')}`,
  })
  sortOrder: FinanceSortOrder = 'desc';
}
