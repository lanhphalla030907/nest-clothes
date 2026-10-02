import type { ProductVariant } from '../../generated/prisma/client.js';
import { Prisma } from '../../generated/prisma/client.js';

/**
 * Outbound representation of a product variant.
 *
 * Exactly the stored columns are exposed — there is no nested `product` to leak
 * even if Prisma ever joins the relation, because `fromEntity` copies field by
 * field rather than spreading the entity. Variants must always be mapped through
 * this DTO.
 */
export class ProductVariantResponseDto {
  id: string;
  productId: string;
  sku: string;
  /**
   * Serialised as a fixed two-decimal **string**, never a JSON number.
   *
   * This is the project-wide money convention: an IEEE-754 double cannot hold
   * every two-decimal value exactly, so a number would allow the amount to drift
   * between the database and the client. The string always carries the same two
   * fraction digits as the `Decimal(12,2)` column.
   */
  price: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;

  static fromEntity(variant: ProductVariant): ProductVariantResponseDto {
    const dto = new ProductVariantResponseDto();

    dto.id = variant.id;
    dto.productId = variant.productId;
    dto.sku = variant.sku;
    dto.price = variant.price instanceof Prisma.Decimal
      ? variant.price.toFixed(2)
      : String(variant.price);
    dto.isActive = variant.isActive;
    dto.createdAt = variant.createdAt;
    dto.updatedAt = variant.updatedAt;
    return dto;
  }
}
