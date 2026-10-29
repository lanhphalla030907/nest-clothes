import type { CodArea } from '../../generated/prisma/client.js';

/** An area is returned publicly only after an administrator enabled COD for it. */
export class PublicCodAreaResponseDto {
  id: string;
  code: string;
  name: string;

  static fromEntity(area: CodArea): PublicCodAreaResponseDto {
    const dto = new PublicCodAreaResponseDto();
    dto.id = area.id;
    dto.code = area.code;
    dto.name = area.name;
    return dto;
  }
}
