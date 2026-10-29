import type { AdministrativeLocation } from '../../generated/prisma/client.js';
import { AdministrativeLocationResponseDto } from './administrative-location-response.dto.js';

export class AdminCodEligibilityResponseDto extends AdministrativeLocationResponseDto {
  codEnabledOverride: boolean | null;
  codEnabled: boolean;

  static fromValues(
    location: AdministrativeLocation,
    codEnabled: boolean,
  ): AdminCodEligibilityResponseDto {
    const dto = Object.assign(
      new AdminCodEligibilityResponseDto(),
      AdministrativeLocationResponseDto.fromEntity(location),
    );
    dto.codEnabledOverride = location.codEnabledOverride;
    dto.codEnabled = codEnabled;
    return dto;
  }
}
