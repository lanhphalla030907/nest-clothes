import type { ProductAttribute } from '../../generated/prisma/client.js';

/**
 * Outbound representation of a product attribute.
 *
 * Exactly the stored columns are exposed — there is no nested `product` to leak
 * even if Prisma ever joins the relation, because `fromEntity` copies field by
 * field rather than spreading the entity. Attributes must always be mapped
 * through this DTO.
 */
export class ProductAttributeResponseDto {
  id: string;
  productId: string;
  attributeName: string;
  attributeValue: string;
  createdAt: Date;
  updatedAt: Date;

  static fromEntity(attribute: ProductAttribute): ProductAttributeResponseDto {
    const dto = new ProductAttributeResponseDto();

    dto.id = attribute.id;
    dto.productId = attribute.productId;
    dto.attributeName = attribute.attributeName;
    dto.attributeValue = attribute.attributeValue;
    dto.createdAt = attribute.createdAt;
    dto.updatedAt = attribute.updatedAt;
    return dto;
  }
}
