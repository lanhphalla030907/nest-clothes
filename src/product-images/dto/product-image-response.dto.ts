import type { ProductImage } from '../../generated/prisma/client.js';

/**
 * Outbound representation of a product image.
 *
 * Exactly the nine stored columns are exposed — there is no nested `product` to
 * leak even if Prisma ever joins the relation, because `fromEntity` copies field
 * by field rather than spreading the entity.
 *
 * `publicId` is included even though nothing consumes it yet. It is part of the
 * record's identity for any future replace or delete operation, and a client
 * that cannot read it cannot reconcile its own state after such an operation.
 * Images must always be mapped through this DTO.
 */
export class ProductImageResponseDto {
  id: string;
  productId: string;
  imageUrl: string;
  publicId: string;
  altText: string | null;
  sortOrder: number;
  isPrimary: boolean;
  createdAt: Date;
  updatedAt: Date;

  static fromEntity(image: ProductImage): ProductImageResponseDto {
    const dto = new ProductImageResponseDto();

    dto.id = image.id;
    dto.productId = image.productId;
    dto.imageUrl = image.imageUrl;
    dto.publicId = image.publicId;
    dto.altText = image.altText;
    dto.sortOrder = image.sortOrder;
    dto.isPrimary = image.isPrimary;
    dto.createdAt = image.createdAt;
    dto.updatedAt = image.updatedAt;
    return dto;
  }
}
