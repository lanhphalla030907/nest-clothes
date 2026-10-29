import { IsIn, IsUUID } from 'class-validator';

export const CHECKOUT_PAYMENT_METHODS = ['ABA_PAYWAY', 'COD'] as const;
export type CheckoutPaymentMethod = (typeof CHECKOUT_PAYMENT_METHODS)[number];

export class CreateCheckoutQuoteDto {
  @IsUUID()
  addressId: string;

  @IsUUID()
  shippingProviderId: string;

  @IsIn(CHECKOUT_PAYMENT_METHODS)
  paymentMethod: CheckoutPaymentMethod;
}
