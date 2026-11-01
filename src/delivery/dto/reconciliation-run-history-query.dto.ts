import { Transform, Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  Matches,
  Max,
  Min,
  Validate,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';

const UTC_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const toOptionalTrimmed = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

@ValidatorConstraint({ name: 'reconciliationHistoryDateRange', async: false })
class ReconciliationHistoryDateRangeConstraint
  implements ValidatorConstraintInterface
{
  validate(_value: unknown, { object }: ValidationArguments): boolean {
    const query = object as ReconciliationRunHistoryQueryDto;
    return (
      query.startDate === undefined ||
      query.endDate === undefined ||
      query.startDate <= query.endDate
    );
  }

  defaultMessage(): string {
    return 'endDate must not be before startDate';
  }
}

/** Filters run history by the run's UTC window start. */
export class ReconciliationRunHistoryQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;

  @IsOptional()
  @Transform(toOptionalTrimmed)
  @IsIn(['running', 'completed', 'failed'])
  status?: 'running' | 'completed' | 'failed';

  @IsOptional()
  @Transform(toOptionalTrimmed)
  @IsIn(['cron', 'manual'])
  triggerType?: 'cron' | 'manual';

  @IsOptional()
  @Transform(toOptionalTrimmed)
  @Matches(UTC_DATE_PATTERN)
  @IsDateString({ strict: true, strictSeparator: true })
  startDate?: string;

  @IsOptional()
  @Transform(toOptionalTrimmed)
  @Matches(UTC_DATE_PATTERN)
  @IsDateString({ strict: true, strictSeparator: true })
  @Validate(ReconciliationHistoryDateRangeConstraint)
  endDate?: string;
}
