import { ValidateIf, IsBoolean } from 'class-validator';

export class UpdateCodEligibilityDto {
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @IsBoolean()
  codEnabledOverride?: boolean | null;
}
