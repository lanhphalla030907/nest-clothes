import { Transform } from 'class-transformer';
import { IsString, Matches, NotEquals } from 'class-validator';
import { normalizeMoney } from '../../common/utils/normalize-money.js';

const MONEY_PATTERN = /^\d{1,10}\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/** Internal-only purchase cost update. Cost is never accepted on public routes. */
export class UpdateVariantCostDto {
  @Transform(({ value }) => normalizeMoney(value))
  @IsString()
  @Matches(MONEY_PATTERN, {
    message: 'costPrice must be a positive amount with at most 2 decimal places and at most 10 integer digits',
  })
  @NotEquals('0.00', { message: 'costPrice must be greater than 0' })
  costPrice: string;

  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @Matches(CURRENCY_PATTERN, {
    message: 'costCurrency must be a 3-letter ISO currency code',
  })
  costCurrency: string;
}
