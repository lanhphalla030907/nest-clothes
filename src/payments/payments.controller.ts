import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { TemporaryUserId } from '../common/decorators/temporary-user-id.decorator.js';
import { CreatePaymentDto } from './dto/create-payment.dto.js';
import { PaywayCallbackAckDto } from './dto/payway-callback-ack.dto.js';
import { parsePaywayCallback } from './dto/payway-callback.parser.js';
import { PaymentResponseDto } from './dto/payment-response.dto.js';
import { PaymentsService } from './payments.service.js';

/** The subset of an Express request this controller reads. */
interface RawBodyRequest {
  body?: unknown;
}

/**
 * The payment endpoints. Routing and validation only — every rule lives in
 * `PaymentsService`.
 *
 * ## Why there is no `@Controller` prefix
 *
 * The two endpoints belong to different subjects and neither nests inside the other:
 * creating a payment is an action *on an order*, while the callback is PayWay posting to
 * *us* and has no path segment a caller controls. A shared prefix would have meant
 * either `/orders/:orderId/payments/aba-payway/callback` — putting PayWay's server under
 * somebody's order id — or inventing a grouping segment that exists only to hold two
 * routes. So each method carries its full path, which is also how the contract was
 * specified.
 *
 * ## Why `@Req()` on the callback instead of `@Body()`
 *
 * Because the global `ValidationPipe` runs `forbidNonWhitelisted` on every `@Body()`, and
 * PayWay — not this project — decides which keys it sends. Taking the raw request and
 * validating it with {@link parsePaywayCallback} is the only way to accept a provider
 * payload that grows new fields without turning every addition into an outage. The
 * trade-off is documented at that function.
 *
 * ## Status codes
 *
 * `200 OK` on both, deliberately.
 *
 * The create endpoint is idempotent: the same request always yields the same scannable
 * payment, whether it made it or is replaying one. A `201` on the first call and a `200`
 * on the retry would make a client's retry behaviour depend on which response it happened
 * to get, and "201 means I must remember this id" is a rule that a dropped response
 * would then break. `200` says what is true every time — here is the QR for this order.
 *
 * The callback must be `200` for a webhook: a non-2xx tells PayWay the delivery failed
 * and it will retry, which is the right behaviour for the two cases that genuinely were
 * not processed (unknown transaction, failed verification) and the wrong behaviour for
 * none of the others.
 */
@Controller()
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  /**
   * Returns a payable ABA PayWay QR for an order the caller owns.
   *
   * `dto` is declared and empty on purpose: see {@link CreatePaymentDto}. With the
   * global pipe, `{}` passes and any supplied `amount` or `currency` is a 400 — the
   * amount being charged is the order's own total and cannot be influenced from here.
   *
   * @throws NotFoundException 404 when the order is not the caller's, or is absent.
   * @throws ConflictException 409 when the order is not `PENDING`.
   */
  @Post('orders/:orderId/payments')
  @HttpCode(HttpStatus.OK)
  createPayment(
    @TemporaryUserId(new ParseUUIDPipe()) userId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: CreatePaymentDto,
  ): Promise<PaymentResponseDto> {
    // `dto` is referenced only so the global pipe has a metatype to validate against;
    // it has no fields to read, and there is nothing in it worth touching.
    void dto;

    return this.paymentsService.createPayment(userId, orderId);
  }

  /**
   * PayWay's webhook: the outcome of a QR payment.
   *
   * Unauthenticated by necessity — PayWay signs nothing here and cannot be given a
   * secret we could verify — and therefore treated as an untrusted *hint*. The service
   * uses the payload only to locate the payment, then asks PayWay server-to-server
   * before anything is written. See `PaymentsService.handlePaywayCallback`.
   */
  @Post('payments/aba-payway/callback')
  @HttpCode(HttpStatus.OK)
  async handlePaywayCallback(
    @Req() request: RawBodyRequest,
  ): Promise<PaywayCallbackAckDto> {
    return this.paymentsService.handlePaywayCallback(
      await parsePaywayCallback(request.body),
    );
  }
}
