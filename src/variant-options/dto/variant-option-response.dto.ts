import type { VariantOption } from '../../generated/prisma/client.js';

/**
 * Outbound representation of a variant option.
 *
 * Exactly the stored columns are exposed — there is no nested `variant` to leak
 * even if Prisma ever joins the relation, because `fromEntity` copies field by
 * field rather than spreading the entity. Options must always be mapped through
 * this DTO.
 */
export class VariantOptionResponseDto {
  id: string;
  variantId: string;
  optionName: string;
  optionValue: string;
  createdAt: Date;
  updatedAt: Date;

  static fromEntity(option: VariantOption): VariantOptionResponseDto {
    const dto = new VariantOptionResponseDto();

    dto.id = option.id;
    dto.variantId = option.variantId;
    dto.optionName = option.optionName;
    dto.optionValue = option.optionValue;
    dto.createdAt = option.createdAt;
    dto.updatedAt = option.updatedAt;
    return dto;
  }
}
