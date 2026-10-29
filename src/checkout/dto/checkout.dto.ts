import { IsDefined, IsUUID, ValidateIf } from 'class-validator';

/**
 * Input contract for `POST /checkout`.
 *
 * The legacy body remains a single `addressId`. New clients send a persisted
 * `quoteId` and a UUID `idempotencyKey`; the service rejects mixed or incomplete
 * forms. Keeping the old form is an explicit compatibility path, not a way to
 * alter or bypass validation of quote-backed checkouts.
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
 * Prices, totals, provider choices and COD area are deliberately absent. They are
 * bound to the server-created quote and cannot be overridden by this request.
 */
export class CheckoutDto {
  /**
   * The saved address to ship to.
   *
   * `@IsUUID()` here and `ParseUUIDPipe`-equivalent behaviour elsewhere: a malformed
   * id is a 400 before the service runs, which leaves 404 for a well-formed id that
   * is absent or belongs to somebody else.
   */
  @ValidateIf((dto: CheckoutDto) => dto.quoteId === undefined)
  @IsDefined()
  @IsUUID()
  addressId?: string;

  @ValidateIf((dto: CheckoutDto) => dto.addressId === undefined)
  @IsDefined()
  @IsUUID()
  quoteId?: string;

  @ValidateIf((dto: CheckoutDto) => dto.addressId === undefined)
  @IsDefined()
  @IsUUID()
  idempotencyKey?: string;
}
