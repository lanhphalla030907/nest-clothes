import { toMoneyString } from '../../common/utils/money.js';
import type { AdministrativeLocationResponseDto } from '../../locations/dto/administrative-location-response.dto.js';
import type { CheckoutPaymentMethod } from './create-checkout-quote.dto.js';

export interface CheckoutQuoteItem {
  variantId: string;
  productName: string;
  sku: string;
  variantOptions: { optionName: string; optionValue: string }[];
  unitPrice: string;
  quantity: number;
  lineTotal: string;
}

export class CheckoutQuoteResponseDto {
  quoteId: string;
  paymentMethod: CheckoutPaymentMethod;
  addressId: string;
  shippingProvider: {
    id: string;
    code: string;
    name: string;
    fee: string;
  };
  administrativeLocationPath: AdministrativeLocationResponseDto[] | null;
  items: CheckoutQuoteItem[];
  subtotal: string;
  shippingFee: string;
  discountAmount: string;
  totalAmount: string;
  currency: string;
  expiresAt: Date;

  static fromValues(values: {
    quoteId: string;
    paymentMethod: CheckoutPaymentMethod;
    addressId: string;
    provider: { id: string; code: string; name: string; baseFee: unknown };
    administrativeLocationPath: AdministrativeLocationResponseDto[] | null;
    items: {
      variantId: string;
      productName: string;
      sku: string;
      variantOptionsSnapshot: { optionName: string; optionValue: string }[];
      unitPrice: { toString(): string };
      quantity: number;
      lineTotal: { toString(): string };
    }[];
    subtotal: { toString(): string };
    shippingFee: { toString(): string };
    discountAmount: { toString(): string };
    totalAmount: { toString(): string };
    currency: string;
    expiresAt: Date;
  }): CheckoutQuoteResponseDto {
    const dto = new CheckoutQuoteResponseDto();
    dto.quoteId = values.quoteId;
    dto.paymentMethod = values.paymentMethod;
    dto.addressId = values.addressId;
    dto.shippingProvider = {
      id: values.provider.id,
      code: values.provider.code,
      name: values.provider.name,
      fee: toMoneyString(values.provider.baseFee),
    };
    dto.administrativeLocationPath = values.administrativeLocationPath;
    dto.items = values.items.map((item) => ({
      variantId: item.variantId,
      productName: item.productName,
      sku: item.sku,
      variantOptions: item.variantOptionsSnapshot,
      unitPrice: toMoneyString(item.unitPrice),
      quantity: item.quantity,
      lineTotal: toMoneyString(item.lineTotal),
    }));
    dto.subtotal = toMoneyString(values.subtotal);
    dto.shippingFee = toMoneyString(values.shippingFee);
    dto.discountAmount = toMoneyString(values.discountAmount);
    dto.totalAmount = toMoneyString(values.totalAmount);
    dto.currency = values.currency;
    dto.expiresAt = values.expiresAt;
    return dto;
  }
}
