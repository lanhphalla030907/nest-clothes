import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  FINANCE_DEFAULT_RANKING_LIMIT,
  FINANCE_MAX_RANKING_LIMIT,
  FINANCE_RANKING_METRICS,
  type FinanceRankingMetric,
} from '../finance.constants.js';
import { FinanceQueryDto } from './finance-query.dto.js';

/** Query contract for `GET /admin/finance/rankings`. */
export class RankingsQueryDto extends FinanceQueryDto {
  @IsOptional()
  @IsIn(FINANCE_RANKING_METRICS, {
    message: `metric must be one of ${FINANCE_RANKING_METRICS.join(', ')}`,
  })
  metric: FinanceRankingMetric = 'revenue';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(FINANCE_MAX_RANKING_LIMIT)
  limit: number = FINANCE_DEFAULT_RANKING_LIMIT;
}
