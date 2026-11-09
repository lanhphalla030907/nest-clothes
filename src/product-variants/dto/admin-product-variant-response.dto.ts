import { Prisma, type ProductVariant } from '../../generated/prisma/client.js';
import { ProductVariantResponseDto } from './product-variant-response.dto.js';

/** Admin-only representation. Public catalogue DTOs deliberately omit cost. */
export class AdminProductVariantResponseDto extends ProductVariantResponseDto {
  costPrice: string | null;
  costCurrency: string | null;
  costEffectiveAt: Date | null;

  static fromEntity(variant: ProductVariant): AdminProductVariantResponseDto {
    const dto = Object.assign(
      new AdminProductVariantResponseDto(),
      ProductVariantResponseDto.fromEntity(variant),
    );
    dto.costPrice =
      variant.costPrice === null
        ? null
        : variant.costPrice instanceof Prisma.Decimal
          ? variant.costPrice.toFixed(2)
          : String(variant.costPrice);
    dto.costCurrency = variant.costCurrency;
    dto.costEffectiveAt = variant.costEffectiveAt;
    return dto;
  }
}
