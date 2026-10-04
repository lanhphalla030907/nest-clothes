import { availableStock } from '../../common/utils/available-stock.js';
import { multiplyMoney, toMoneyString } from '../../common/utils/money.js';
import type { ProductStatus } from '../../products/constants/product-status.constants.js';
import type { CartItemCatalog } from '../repositories/cart.repository.js';

/** Public catalog facts about the variant a line refers to. */
export class CartItemVariantDto {
  id: string;
  sku: string;
  /** Fixed two-decimal string, per the project-wide money convention. */
  price: string;
  isActive: boolean;
  /** Descriptive axes such as `Color = Black`, ordered for a stable render. */
  options: { optionName: string; optionValue: string }[];

  static fromCatalog(variant: CartItemCatalog['variant']): CartItemVariantDto {
    const dto = new CartItemVariantDto();

    dto.id = variant.id;
    dto.sku = variant.sku;
    dto.price = toMoneyString(variant.price);
    dto.isActive = variant.isActive;
    dto.options = variant.options.map((option) => ({
      optionName: option.optionName,
      optionValue: option.optionValue,
    }));
    return dto;
  }
}

/** Public catalog facts about the product the line's variant belongs to. */
export class CartItemProductDto {
  id: string;
  name: string;
  slug: string;
  basePrice: string;
  status: ProductStatus;
  isActive: boolean;

  static fromCatalog(
    product: NonNullable<CartItemCatalog['variant']['product']>,
  ): CartItemProductDto {
    const dto = new CartItemProductDto();

    dto.id = product.id;
    dto.name = product.name;
    dto.slug = product.slug;
    dto.basePrice = toMoneyString(product.basePrice);
    dto.status = product.status as ProductStatus;
    dto.isActive = product.isActive;
    return dto;
  }
}

/**
 * Outbound representation of one cart line.
 *
 * The stored columns are joined by the *current* variant, product and inventory
 * rather than a snapshot taken when the item was added: a cart records intent,
 * not a frozen quote, so a price change must be visible immediately.
 *
 * `available` is the sellable amount read at response time and is derived, never
 * stored. `exceedsAvailable` is the derived warning that the line is no longer
 * buyable as it stands — the cart does **not** reserve stock, so this is the only
 * signal a client gets that its quantity has to come down. It is a flag, not a
 * rejection: checkout is where an unfulfillable line becomes an error.
 *
 * `lineTotal` is `unitPrice * quantity`, computed with `Decimal` so the
 * multiplication never passes through a float, and returned as a two-decimal
 * string like every other amount in this project.
 *
 * The nested `variant` and `product` objects are built field by field by
 * `fromCatalog`, so no unexpected column — a password hash, an internal flag, a
 * raw Prisma object — can leak into a response.
 */
export class CartItemResponseDto {
  id: string;
  cartId: string;
  variantId: string;
  quantity: number;
  /** Current sellable stock: `quantity - reservedQuantity`, or `null` when the variant has no inventory row. */
  available: number | null;
  /** True when the line cannot currently be fulfilled as it stands. */
  exceedsAvailable: boolean;
  unitPrice: string;
  lineTotal: string;
  variant: CartItemVariantDto;
  product: CartItemProductDto;
  createdAt: Date;
  updatedAt: Date;

  static fromCatalog(item: CartItemCatalog): CartItemResponseDto {
    const dto = new CartItemResponseDto();
    const available = availableStockOrNull(item.variant.inventory);

    dto.id = item.id;
    dto.cartId = item.cartId;
    dto.variantId = item.variantId;
    dto.quantity = item.quantity;
    dto.available = available;
    dto.exceedsAvailable = available === null || item.quantity > available;
    dto.unitPrice = toMoneyString(item.variant.price);
    dto.lineTotal = multiplyMoney(
      toMoneyString(item.variant.price),
      item.quantity,
    );
    dto.variant = CartItemVariantDto.fromCatalog(item.variant);
    dto.product = CartItemProductDto.fromCatalog(item.variant.product);
    dto.createdAt = item.createdAt;
    dto.updatedAt = item.updatedAt;
    return dto;
  }
}

/**
 * The sellable amount for a line's variant, or `null` when the variant has no
 * inventory row at all.
 *
 * `null` is distinct from `0` on purpose: `0` means "stocked and sold out",
 * while `null` means "this variant is not stocked", and a storefront shows those
 * differently. It should not happen for a line that exists — the service refuses
 * to create one — but the read must not invent a number if it ever does.
 */
function availableStockOrNull(
  inventory: CartItemCatalog['variant']['inventory'],
): number | null {
  return inventory === null ? null : availableStock(inventory);
}
