import type { Category } from '../../generated/prisma/client.js';

/**
 * Outbound representation of a category.
 *
 * Only the public catalog fields are listed. Anything that is a storage detail
 * rather than part of the published shape (for example the related `parent` and
 * `children` rows Prisma can eagerly join) is absent, so a category can never
 * leak internal structure into an API response. Categories must always be
 * mapped through this DTO.
 */
export class CategoryResponseDto {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  parentId: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;

  static fromEntity(category: Category): CategoryResponseDto {
    const dto = new CategoryResponseDto();

    dto.id = category.id;
    dto.name = category.name;
    dto.slug = category.slug;
    dto.description = category.description;
    dto.parentId = category.parentId;
    dto.isActive = category.isActive;
    dto.createdAt = category.createdAt;
    dto.updatedAt = category.updatedAt;
    return dto;
  }
}