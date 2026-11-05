import type { Poster } from '../../generated/prisma/client.js';

/**
 * Outbound representation of a poster.
 *
 * Only the public poster fields are listed, so storage details never leak into
 * an API response. Posters must always be mapped through this DTO.
 */
export class PosterResponseDto {
  id: string;
  title: string | null;
  imageUrl: string;
  publicId: string;
  isActive: boolean;
  displayOrder: number;
  createdAt: Date;
  updatedAt: Date;

  static fromEntity(poster: Poster): PosterResponseDto {
    const dto = new PosterResponseDto();

    dto.id = poster.id;
    dto.title = poster.title;
    dto.imageUrl = poster.imageUrl;
    dto.publicId = poster.publicId;
    dto.isActive = poster.isActive;
    dto.displayOrder = poster.displayOrder;
    dto.createdAt = poster.createdAt;
    dto.updatedAt = poster.updatedAt;
    return dto;
  }
}
