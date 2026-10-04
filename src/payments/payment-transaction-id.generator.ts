import { randomInt } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  PAYWAY_MAX_TRANSACTION_ID_LENGTH,
} from './payway/payway.constants.js';
import { isValidPaywayTransactionId } from './payway/payway-hash.js';

/**
 * Generation of `payments.transaction_id` — PayWay's `tran_id`.
 *
 * ## Why this cannot be the order number, or a UUID
 *
 * PayWay caps `tran_id` at **20 characters**. That single constraint decides the shape:
 *
 * - the customer-facing `ORD-20261004-K7QP3M` is 21 characters and does not fit;
 * - a UUID is 36 and does not fit;
 * - truncating either to fit would map many distinct payments onto one provider
 *   transaction, which is the worst possible failure for an identifier whose whole job
 *   is to be unique.
 *
 * So the transaction id gets its own compact format rather than a mangled version of
 * something else:
 *
 * ```
 * PW261004073012-8F3K2Q
 * │ │ │      │      │
 * │ │ │      │      └── six random characters from a 36-symbol alphabet
 * │ │ │      └───────── UTC time of issue (HHmmss)
 * │ │ └──────────────── UTC date of issue (YYMMDD)
 * │ └────────────────── fixed prefix, so it is never confused with an order number
 * └───────────────────── provider is PayWay
 * ```
 *
 * Two characters of prefix, twelve of timestamp, six of entropy: exactly
 * {@link PAYWAY_MAX_TRANSACTION_ID_LENGTH}.
 *
 * ## The timestamp is there to be *read*, not to be unique
 *
 * `YYMMDDHHmmss` narrows a collision to two payments started in the same second, and
 * the six random characters then resolve that — 36^6 ≈ 2.18 billion values within a
 * single second, so the odds of two payments *both* colliding are negligible.
 *
 * It is still worth encoding, for two reasons. PayWay support asks for a transaction id
 * first, and one that begins with a date and time is diagnosable by a human on the
 * phone. And it means the value is not opaque: an id that looks random invites the
 * question "which one is mine?", and an answer nobody can give.
 *
 * ## Uniqueness is guaranteed by the database, not here
 *
 * Layered exactly as `OrderNumberGenerator` documents it, and for the same reasons:
 * entropy makes an accidental collision very unlikely, and the
 * `payments_transaction_id_key` unique index is the only authority. Two concurrent
 * requests can both generate an id that is free a moment before either row exists, so
 * the *writer* is what retries on collision — this class only produces candidates and
 * never claims one is unused.
 *
 * `randomInt` rather than `Math.random`, because "unpredictable" is the property being
 * bought and `Math.random` is a general-purpose PRNG whose output is predictable from
 * a few observed values.
 */

/** Fixed prefix. Two characters is what the 20-character budget can spare. */
const TRANSACTION_ID_PREFIX = 'PW';

/**
 * Uppercase alphanumerics, matching `ORDER_NUMBER_ALPHABET`.
 *
 * The same alphabet as order numbers, and for the same reasons: it survives being read
 * aloud, typed into a form and quoted to PayWay support, and it excludes nothing —
 * shrinking the space to avoid `O`/`0` ambiguity would trade a real collision risk for
 * a cosmetic one.
 */
const TRANSACTION_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** How many random characters follow the timestamp. Six ⇒ 36^6 ≈ 2.18e9 per second. */
const RANDOM_SUFFIX_LENGTH = 6;

/** `YYMMDDHHmmss`, UTC. */
function formatTimestamp(date: Date): string {
  const year = date.getUTCFullYear().toString().padStart(2, '0').slice(-2);
  const month = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = date.getUTCDate().toString().padStart(2, '0');
  const hours = date.getUTCHours().toString().padStart(2, '0');
  const minutes = date.getUTCMinutes().toString().padStart(2, '0');
  const seconds = date.getUTCSeconds().toString().padStart(2, '0');

  return `${year}${month}${day}${hours}${minutes}${seconds}`;
}

/** One cryptographically random character, uniformly distributed over the alphabet. */
function randomCharacter(): string {
  return TRANSACTION_ID_ALPHABET[randomInt(TRANSACTION_ID_ALPHABET.length)];
}

@Injectable()
export class TransactionIdGenerator {
  /**
   * Returns one candidate transaction id.
   *
   * `date` exists for the same reason `OrderNumberGenerator.build` takes one: a test
   * that pins the timestamp gets a deterministic prefix and asserts on the shape of the
   * random suffix alone.
   *
   * @throws Error if the assembled id does not fit PayWay's limit. A candidate that
   *   could not be sent must fail here, loudly, rather than at the HTTP boundary where
   *   the failure would look like PayWay's problem.
   */
  build(date: Date = new Date()): string {
    const timestamp = formatTimestamp(date);
    let suffix = '';

    for (let index = 0; index < RANDOM_SUFFIX_LENGTH; index += 1) {
      suffix += randomCharacter();
    }

    const transactionId = `${TRANSACTION_ID_PREFIX}${timestamp}${suffix}`;

    if (!isValidPaywayTransactionId(transactionId)) {
      throw new Error(
        `Generated transaction id is ${transactionId.length} characters; PayWay allows at most ${PAYWAY_MAX_TRANSACTION_ID_LENGTH}`,
      );
    }

    return transactionId;
  }

  /** Every transaction id matches this. Exported for reuse and for tests. */
  static readonly PATTERN = /^PW\d{12}[A-Z0-9]{6}$/;
}
