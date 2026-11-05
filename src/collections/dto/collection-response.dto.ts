import type { Collection } from '../../generated/prisma/client.js';

export class CollectionResponseDto {
  id: string;
  title: string;
  slug: string;
  description: string | null;
  coverImage: string;
  isActive: boolean;
  displayOrder: number;
  createdAt: Date;
  updatedAt: Date;
  productCount?: number;

  static fromEntity(collection: Collection, productCount?: number): CollectionResponseDto {
    const dto = new CollectionResponseDto();
    dto.id = collection.id;
    dto.title = collection.title;
    dto.slug = collection.slug;
    dto.description = collection.description;
    dto.coverImage = collection.coverImage;
    dto.isActive = collection.isActive;
    dto.displayOrder = collection.displayOrder;
    dto.createdAt = collection.createdAt;
    dto.updatedAt = collection.updatedAt;
    if (productCount !== undefined) dto.productCount = productCount;
    return dto;
  }
}
