import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

/** Pagination for a reconciliation run's immutable snapshot items. */
export class ReconciliationRunDetailQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}
