import { Transform } from 'class-transformer';
import { IsIn, IsOptional } from 'class-validator';
import {
  FINANCE_DEFAULT_GRANULARITY,
  FINANCE_TREND_GRANULARITIES,
  type FinanceTrendGranularity,
} from '../finance.constants.js';
import { FinanceQueryDto } from './finance-query.dto.js';
import { toLowerTrimmed } from './finance-query.transforms.js';

/** Query contract for `GET /admin/finance/revenue-trend`. */
export class RevenueTrendQueryDto extends FinanceQueryDto {
  @IsOptional()
  @Transform(toLowerTrimmed)
  @IsIn(FINANCE_TREND_GRANULARITIES, {
    message: `granularity must be one of ${FINANCE_TREND_GRANULARITIES.join(
      ', ',
    )}`,
  })
  granularity: FinanceTrendGranularity = FINANCE_DEFAULT_GRANULARITY;
}
