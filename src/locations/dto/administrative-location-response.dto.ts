import type { AdministrativeLocation } from '../../generated/prisma/client.js';

export class AdministrativeLocationResponseDto {
  pcode: string;
  parentPcode: string | null;
  adminLevel: number;
  nameEn: string;
  nameKm: string | null;

  static fromEntity(
    location: AdministrativeLocation,
  ): AdministrativeLocationResponseDto {
    const dto = new AdministrativeLocationResponseDto();
    dto.pcode = location.pcode;
    dto.parentPcode = location.parentPcode;
    dto.adminLevel = location.adminLevel;
    dto.nameEn = location.nameEn;
    dto.nameKm = location.nameKm;
    return dto;
  }
}
