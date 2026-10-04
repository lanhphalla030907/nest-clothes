import { IsUUID } from 'class-validator';

/**
 * Input contract for `POST /checkout`.
 *
 * The entire body is one field, and that is the design rather than an omission.
 * Everything else a checkout needs is already on the server and is read from there:
 *
 * - **what to buy** comes from the cart, so the client cannot order a variant it
 *   never put in the cart, or a quantity different from the one it did;
 * - **what it costs** comes from the catalogue at commit time, so no field here
 *   could be a price;
 * - **where it goes** is `addressId`, an id *this user owns* — the address itself is
 *   copied from the stored row, so a client cannot ship to an address string it
 *   made up, and cannot ship to somebody else's address either.
 *
 * `id`, `status`, `currency`, `subtotal`, `totalAmount` and every timestamp are
 * intentionally absent. The global `ValidationPipe` runs with `forbidNonWhitelisted`,
 * so a client that tries to set any of them is rejected with 400 rather than having
 * them silently dropped — sending `{"addressId": "…", "totalAmount": "0.01"}` is a
 * rejected request, not a free order.
 *
 * There is deliberately no `paymentMethod`, `shippingOption` or `couponCode`. Those
 * are features that do not exist yet; accepting them as ignored fields would be a
 * promise this phase cannot keep.
 */
export class CheckoutDto {
  /**
   * The saved address to ship to.
   *
   * `@IsUUID()` here and `ParseUUIDPipe`-equivalent behaviour elsewhere: a malformed
   * id is a 400 before the service runs, which leaves 404 for a well-formed id that
   * is absent or belongs to somebody else.
   */
  @IsUUID()
  addressId: string;
}
