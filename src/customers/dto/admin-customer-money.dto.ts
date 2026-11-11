/**
 * One currency's money total for a customer.
 *
 * The amount is the project's fixed two-decimal string convention, because a
 * JSON number cannot represent every two-decimal value exactly.
 *
 * Currencies are always reported per currency and never combined: the
 * application has no exchange rate, so a customer who spent in two currencies
 * appears as two entries rather than one invented total.
 */
export interface AdminCustomerMoneyDto {
  currency: string;
  amount: string;
}
