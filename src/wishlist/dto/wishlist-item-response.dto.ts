import { availableStock } from '../../common/utils/available-stock.js';
import { toMoneyString } from '../../common/utils/money.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { ProductStatus } from '../../products/constants/product-status.constants.js';
import type { WishlistItemProduct } from '../repositories/wishlist.repository.js';

/** The one image a wishlist card renders. */
export class WishlistItemImageDto {
  imageUrl: string;
  altText: string | null;

  static fromImage(image: {
    imageUrl: string;
    altText: string | null;
  }): WishlistItemImageDto {
    const dto = new WishlistItemImageDto();

    dto.imageUrl = image.imageUrl;
    dto.altText = image.altText;
    return dto;
  }
}

/**
 * Public catalog facts about one *active* variant of a saved product.
 *
 * Inactive variants are filtered out by the query rather than by this DTO, so
 * nothing here has to decide whether a variant is offerable.
 */
export class WishlistItemVariantDto {
  id: string;
  sku: string;
  /** Fixed two-decimal string, per the project-wide money convention. */
  price: string;
  /**
   * Current sellable stock: `quantity - reservedQuantity`, or `null` when the
   * variant has no inventory row at all.
   */
  available: number | null;
  /** Descriptive axes such as `Color = Black`, ordered for a stable render. */
  options: { optionName: string; optionValue: string }[];

  static fromCatalog(
    variant: WishlistItemProduct['product']['variants'][number],
  ): WishlistItemVariantDto {
    const dto = new WishlistItemVariantDto();

    dto.id = variant.id;
    dto.sku = variant.sku;
    dto.price = toMoneyString(variant.price);
    dto.available = availableStockOrNull(variant.inventory);
    dto.options = variant.options.map((option) => ({
      optionName: option.optionName,
      optionValue: option.optionValue,
    }));
    return dto;
  }
}

/**
 * Public catalog facts about the saved product.
 *
 * The product is joined at *read* time rather than snapshotted when the product was
 * saved: a wishlist is a standing interest in a product, not a quote, so a rename,
 * a repricing or a deactivation has to be visible immediately.
 *
 * `priceRange` is derived from the active variants, not from `basePrice`, because
 * `basePrice` is the catalogue's starting figure while the amount actually charged
 * belongs to a variant. It is `null` when the product has no active variant, which
 * also means it cannot currently be bought at all.
 *
 * `inStock` is the derived flag a card actually needs: it is `true` only when some
 * active variant has stock left. Like the cart, a wishlist claims nothing — this is
 * a reading of the current counters, not a guarantee that the product will still be
 * available later.
 */
export class WishlistItemProductDto {
  id: string;
  name: string;
  slug: string;
  /** Fixed two-decimal string; the catalogue's starting figure, not the amount charged. */
  basePrice: string;
  status: ProductStatus;
  isActive: boolean;
  /** The primary image, falling back to the earliest by display order. */
  image: WishlistItemImageDto | null;
  /** `{ min, max }` over the active variants' prices, or `null` when there are none. */
  priceRange: { min: string; max: string } | null;
  inStock: boolean;
  variants: WishlistItemVariantDto[];

  static fromCatalog(item: WishlistItemProduct): WishlistItemProductDto {
    const dto = new WishlistItemProductDto();
    const { product } = item;
    const variants = product.variants.map((variant) =>
      WishlistItemVariantDto.fromCatalog(variant),
    );
    const image = product.images[0];

    dto.id = product.id;
    dto.name = product.name;
    dto.slug = product.slug;
    dto.basePrice = toMoneyString(product.basePrice);
    dto.status = product.status as ProductStatus;
    dto.isActive = product.isActive;
    dto.image =
      image === undefined ? null : WishlistItemImageDto.fromImage(image);
    dto.priceRange = priceRangeOf(variants);
    dto.inStock = variants.some((variant) => (variant.available ?? 0) > 0);
    dto.variants = variants;
    return dto;
  }
}

/**
 * Outbound representation of one saved product.
 *
 * There is no `quantity` and no `updatedAt`, because the row has neither: a saved
 * item is immutable, and the only way to change one is to delete it.
 *
 * The nested `product` object is built field by field by `fromCatalog`, so no
 * unexpected column — an internal flag, a raw Prisma object, a password hash
 * reached through some future relation — can leak into a response.
 */
export class WishlistItemResponseDto {
  id: string;
  wishlistId: string;
  productId: string;
  product: WishlistItemProductDto;
  createdAt: Date;

  static fromCatalog(item: WishlistItemProduct): WishlistItemResponseDto {
    const dto = new WishlistItemResponseDto();

    dto.id = item.id;
    dto.wishlistId = item.wishlistId;
    dto.productId = item.productId;
    dto.product = WishlistItemProductDto.fromCatalog(item);
    dto.createdAt = item.createdAt;
    return dto;
  }
}

/**
 * The cheapest and dearest active variant price, or `null` when the product has
 * none active.
 *
 * `min` and `max` are equal for a single-variant product, which is the common case;
 * reporting a range rather than a single number keeps the client from having to
 * know whether a price shown on a card is a floor or an exact amount.
 *
 * The comparison runs on `Decimal` rather than on the strings: `"9.90"` sorts
 * before `"10.00"` as text, which is the opposite of the truth.
 */
function priceRangeOf(
  variants: WishlistItemVariantDto[],
): { min: string; max: string } | null {
  if (variants.length === 0) {
    return null;
  }

  let min = new Prisma.Decimal(variants[0].price);
  let max = min;

  for (const variant of variants.slice(1)) {
    const price = new Prisma.Decimal(variant.price);

    if (price.lessThan(min)) {
      min = price;
    }

    if (price.greaterThan(max)) {
      max = price;
    }
  }

  return { min: min.toFixed(2), max: max.toFixed(2) };
}

/**
 * The sellable amount for a variant, or `null` when it has no inventory row.
 *
 * `null` is distinct from `0` on purpose: `0` means "stocked and sold out", `null`
 * means "this variant is not stocked", and a storefront shows those differently.
 */
function availableStockOrNull(
  inventory: { quantity: number; reservedQuantity: number } | null,
): number | null {
  return inventory === null ? null : availableStock(inventory);
}
