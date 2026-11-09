import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export const CHECKOUT_PAYMENT_METHODS = ['ABA_PAYWAY', 'COD'] as const;
export type CheckoutPaymentMethod = (typeof CHECKOUT_PAYMENT_METHODS)[number];

export class CreateCheckoutQuoteDto {
  @IsUUID()
  addressId: string;

  @IsUUID()
  shippingProviderId: string;

  @IsIn(CHECKOUT_PAYMENT_METHODS)
  paymentMethod: CheckoutPaymentMethod;

  /**
   * An optional customer-entered coupon code.
   *
   * The value is only an *input* to the server-side evaluation. It is normalised
   * (trimmed and uppercased) by the promotion domain, and every monetary figure
   * is recomputed from the cart and the catalogue. No amount is accepted here.
   */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  couponCode?: string;
}
