import {
  IsDateString,
  Validate,
  ValidateIf,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
  type ValidationArguments,
} from 'class-validator';
import { Matches } from 'class-validator';

const UTC_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UTC_DATETIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

@ValidatorConstraint({ name: 'reconciliationWindowSelection', async: false })
class ReconciliationWindowSelectionConstraint
  implements ValidatorConstraintInterface
{
  validate(_value: unknown, { object }: ValidationArguments): boolean {
    const body = object as ManualReconciliationTriggerDto;
    const hasDate = body.date !== undefined;
    const hasStart = body.windowStart !== undefined;
    const hasEnd = body.windowEnd !== undefined;

    return (
      !(hasDate && (hasStart || hasEnd)) &&
      hasStart === hasEnd &&
      (!hasStart ||
        new Date(body.windowStart!).getTime() <
          new Date(body.windowEnd!).getTime())
    );
  }

  defaultMessage(): string {
    return 'provide either date or an ordered windowStart/windowEnd pair';
  }
}

/** Optional UTC date or explicit UTC half-open window for manual reconciliation. */
export class ManualReconciliationTriggerDto {
  @Validate(ReconciliationWindowSelectionConstraint)
  private readonly windowSelection = true;

  @ValidateIf((body: ManualReconciliationTriggerDto) => body.date !== undefined)
  @Matches(UTC_DATE_PATTERN)
  @IsDateString({ strict: true, strictSeparator: true })
  date?: string;

  @ValidateIf(
    (body: ManualReconciliationTriggerDto) =>
      body.windowStart !== undefined || body.windowEnd !== undefined,
  )
  @IsDateString({ strict: true, strictSeparator: true })
  @Matches(UTC_DATETIME_PATTERN)
  windowStart?: string;

  @ValidateIf(
    (body: ManualReconciliationTriggerDto) =>
      body.windowStart !== undefined || body.windowEnd !== undefined,
  )
  @IsDateString({ strict: true, strictSeparator: true })
  @Matches(UTC_DATETIME_PATTERN)
  windowEnd?: string;
}
