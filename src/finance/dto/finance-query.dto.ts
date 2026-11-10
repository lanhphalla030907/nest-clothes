import { Transform } from 'class-transformer';
import { IsIn, IsOptional } from 'class-validator';
import {
  FINANCE_BASES,
  FINANCE_DEFAULT_BASIS,
  type FinanceBasis,
} from '../finance.constants.js';
import { FinanceDateRangeQueryDto } from './finance-date-range-query.dto.js';
import { toLowerTrimmed } from './finance-query.transforms.js';

/**
 * The reporting basis shared by revenue, trend, product and ranking queries.
 *
 * `delivered` recognises revenue at the successful delivery event; `booked`
 * recognises it when the money is evidenced (a `PAID` online payment or a COD
 * collection). They are not interchangeable: COD can be collected before
 * delivery, and a delivered COD order can remain uncollected.
 */
export class FinanceQueryDto extends FinanceDateRangeQueryDto {
  @IsOptional()
  @Transform(toLowerTrimmed)
  @IsIn(FINANCE_BASES, {
    message: `basis must be one of ${FINANCE_BASES.join(', ')}`,
  })
  basis: FinanceBasis = FINANCE_DEFAULT_BASIS;
}
