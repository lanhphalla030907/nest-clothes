import type { Product } from '../../generated/prisma/client.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { ProductStatus } from '../constants/product-status.constants.js';

/**
 * Outbound representation of a product.
 *
 * Only the public catalog fields are listed. Anything that is a storage detail
 * rather than part of the published shape (for example the related `category`
 * row Prisma can eagerly join) is absent, so a product can never leak internal
 * structure into an API response. Products must always be mapped through this
 * DTO.
 */
export class ProductResponseDto {
  id: string;
  categoryId: string;
  name: string;
  slug: string;
  description: string | null;
  /**
   * Serialised as a fixed two-decimal **string**, never a JSON number.
   *
   * This is the project-wide money convention: an IEEE-754 double cannot hold
   * every two-decimal value exactly, so a number would allow the amount to drift
   * between the database and the client. The string always carries the same two
   * fraction digits as the `Decimal(12,2)` column.
   */
  basePrice: string;
  status: ProductStatus;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;

  static fromEntity(product: Product): ProductResponseDto {
    const dto = new ProductResponseDto();

    dto.id = product.id;
    dto.categoryId = product.categoryId;
    dto.name = product.name;
    dto.slug = product.slug;
    dto.description = product.description;
    dto.basePrice = product.basePrice instanceof Prisma.Decimal
      ? product.basePrice.toFixed(2)
      : String(product.basePrice);
    dto.status = product.status as ProductStatus;
    dto.isActive = product.isActive;
    dto.createdAt = product.createdAt;
    dto.updatedAt = product.updatedAt;
    return dto;
  }
}