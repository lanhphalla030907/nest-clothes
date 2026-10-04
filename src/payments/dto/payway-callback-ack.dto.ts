/**
 * What `POST /payments/aba-payway/callback` returns.
 *
 * ## Deliberately almost empty
 *
 * This endpoint is unauthenticated, so anything it echoes is information a prober
 * could read by posting arbitrary values at it. The three factories below therefore
 * report only *what this application did* — never a payment id, an amount, an order
 * number, or anything else it would have to look up in order to say.
 *
 * That is enough for PayWay, which wants to know the webhook was received and
 * processed so it stops retrying. The two failure modes that matter — "you sent a
 * transaction id we do not know" and "that payment does not match the order" — are
 * raised as 404 and 409 instead, because a webhook that was *not* processed should not
 * be acknowledged as though it was.
 */
export class PaywayCallbackAckDto {
  /**
   * One of:
   *
   * - `RECORDED` — this delivery verified the payment and confirmed the order;
   * - `ALREADY_RECORDED` — it was already `PAID`, so the delivery was a duplicate and
   *   no provider call was needed;
   * - `NOT_COLLECTED` — PayWay confirms the transaction has not been paid yet. Not an
   *   error: the customer may still be scanning, and the attempt stays open.
   */
  status: string;

  private constructor(status: string) {
    this.status = status;
  }

  static recorded(): PaywayCallbackAckDto {
    return new PaywayCallbackAckDto('RECORDED');
  }

  static alreadyRecorded(): PaywayCallbackAckDto {
    return new PaywayCallbackAckDto('ALREADY_RECORDED');
  }

  static notCollected(): PaywayCallbackAckDto {
    return new PaywayCallbackAckDto('NOT_COLLECTED');
  }
}
