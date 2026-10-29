import type { CodArea } from '../../generated/prisma/client.js';

export class CodAreaResponseDto {
  id: string;
  code: string;
  name: string;
  codEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;

  static fromEntity(area: CodArea): CodAreaResponseDto {
    const dto = new CodAreaResponseDto();
    dto.id = area.id;
    dto.code = area.code;
    dto.name = area.name;
    dto.codEnabled = area.codEnabled;
    dto.createdAt = area.createdAt;
    dto.updatedAt = area.updatedAt;
    return dto;
  }
}
