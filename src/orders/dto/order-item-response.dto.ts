import { toMoneyString } from '../../common/utils/money.js';
import type { OrderItem } from '../repositories/order.repository.js';

/**
 * One axis of a variant as it was when the order was placed, for example
 * `{ optionName: 'Color', optionValue: 'Black' }`.
 *
 * A value, not a row reference: `variant_options` can be edited or deleted
 * without touching this snapshot, which is the whole point of storing it.
 */
export class OrderItemVariantOptionDto {
  optionName: string;
  optionValue: string;

  /**
   * Narrows an arbitrary JSONB value to the array of well-formed option pairs a
   * client can render.
   *
   * Every entry is checked rather than cast: `variant_options_snapshot` is JSONB,
   * so the database guarantees only that it *is* valid JSON, not that it matches
   * the shape the checkout wrote. Reading defensively here means a malformed
   * snapshot degrades to `[]` instead of producing a response the client cannot
   * parse — the right trade for a display field, and the reason a well-formed
   * snapshot is required at write time instead.
   */
  static fromSnapshot(options: unknown): OrderItemVariantOptionDto[] {
    if (!Array.isArray(options)) {
      return [];
    }

    return options
      .filter(
        (option): option is { optionName: string; optionValue: string } =>
          typeof option === 'object' &&
          option !== null &&
          typeof (option as { optionName?: unknown }).optionName === 'string' &&
          typeof (option as { optionValue?: unknown }).optionValue === 'string',
      )
      .map((option) => {
        const dto = new OrderItemVariantOptionDto();

        dto.optionName = option.optionName;
        dto.optionValue = option.optionValue;
        return dto;
      });
  }
}

/**
 * Outbound representation of one order line.
 *
 * Every value here comes from the row's own snapshot columns. Nothing is joined
 * from `products`, `product_variants` or `variant_options`, so renaming a product
 * or repricing a variant cannot change what an old order says. That is the single
 * most important property of this DTO and the reason {@link OrderItem} exists.
 *
 * ## Money
 *
 * `unitPrice` and `lineTotal` are fixed two-decimal **strings**, matching every
 * other amount in this project. A JSON number cannot represent every two-decimal
 * value exactly, so a number would let the figure drift between the database and
 * the client.
 *
 * `lineTotal` is read from the column rather than recomputed as
 * `unitPrice * quantity`. The stored value is the one the customer was charged and
 * the database's `CHECK` constraint guarantees it equals that product — recomputing
 * it here would duplicate arithmetic that is already enforced, and could only ever
 * introduce a second answer.
 *
 * ## `variantOptionsSnapshot`
 *
 * Returned as a structured array rather than the raw JSONB value, so a client
 * receives `[{ optionName, optionValue }]` it can render directly. A snapshot that
 * is not an array of well-formed pairs — an empty variant legitimately has none —
 * yields `[]` rather than leaking an unexpected shape into the response.
 */
export class OrderItemResponseDto {
  id: string;
  orderId: string;
  /**
   * The variant this line was sold from.
   *
   * Present so a client can link to the product page; **not** used to derive any
   * other field here. The variant may since have been repriced, renamed or
   * deactivated, and the fields below deliberately do not reflect that.
   */
  variantId: string;
  /** Product name as it was when the order was placed. */
  productName: string;
  /** SKU as it was when the order was placed. */
  sku: string;
  /** Variant options as they were when the order was placed. */
  variantOptionsSnapshot: OrderItemVariantOptionDto[];
  /** Price paid per unit, as a fixed two-decimal string. */
  unitPrice: string;
  quantity: number;
  /** `unitPrice × quantity`, as stored and as a fixed two-decimal string. */
  lineTotal: string;
  createdAt: Date;

  static fromEntity(item: OrderItem): OrderItemResponseDto {
    const dto = new OrderItemResponseDto();

    dto.id = item.id;
    dto.orderId = item.orderId;
    dto.variantId = item.variantId;
    dto.productName = item.productName;
    dto.sku = item.sku;
    dto.variantOptionsSnapshot = OrderItemVariantOptionDto.fromSnapshot(
      item.variantOptionsSnapshot,
    );
    dto.unitPrice = toMoneyString(item.unitPrice);
    dto.quantity = item.quantity;
    dto.lineTotal = toMoneyString(item.lineTotal);
    dto.createdAt = item.createdAt;
    return dto;
  }
}