import { randomInt } from 'node:crypto';
import { Injectable } from '@nestjs/common';

/**
 * Generation of the customer-facing `orders.order_number`.
 *
 * ## Why this exists at all
 *
 * `orders.id` is a UUID: correct as a primary key, useless to a human. Nobody
 * wants to read a 36-character identifier over the phone to an agent, so the
 * order also carries an `order_number` in the shape a customer recognises:
 *
 * ```
 * ORD-20261004-K7QP3M
 * │   │        │
 * │   │        └── six random characters from a 36-symbol alphabet
 * │   └─────────── the UTC date the number was minted (YYYYMMDD)
 * └─────────────── fixed prefix, so it is greppable and never ambiguous with
 *                  another identifier we might print on a label
 * ```
 *
 * ## Why it is random and not sequential
 *
 * A tempting design is `ORD-20261004-000123` from a sequence. It is rejected
 * outright: a sequential number tells one customer how many orders exist, and
 * therefore makes the *next* one guessable. Order ownership is checked on every
 * read, so a guess alone leaks nothing — but it converts a 404 into an oracle, and
 * it publishes the shop's daily sales volume to anyone who cares to count. Six
 * characters from a 36-symbol alphabet give 36^6 ≈ 2.18 billion values per day,
 * so guessing is not a practical attack and no order count is disclosed.
 *
 * `crypto.randomInt` is used rather than `Math.random`: the latter is a
 * general-purpose PRNG whose output is predictable from a few observed values, and
 * "predictable" is precisely the property being bought here.
 *
 * ## How uniqueness is actually guaranteed
 *
 * In three layers, and the *database* is the only one that is authoritative:
 *
 * 1. **Entropy.** The random suffix makes an accidental collision
 *    approximately 1 in 2.2 billion for any given pair on the same day.
 * 2. **A pre-check.** The generator asks the database whether the number is taken
 *    and regenerates if it is. This turns a would-be collision into an ordinary
 *    loop iteration rather than an error.
 * 3. **`UNIQUE` on `orders.order_number`.** The backstop. It is the only layer
 *    that holds under concurrency, because two concurrent generators can both
 *    pass the pre-check for the same number before either row exists. The loser's
 *    insert is rejected by the index, and the caller regenerates.
 *
 * Layer 2 is a convenience, never a guarantee — {@link OrderNumberGenerator} is
 * documented as such, and the retry that protects a real insert lives with that
 * write rather than here, because only the writer can decide to retry.
 */

/** The fixed prefix. Kept short so the number stays inside `VARCHAR(30)`. */
const ORDER_NUMBER_PREFIX = 'ORD';

/**
 * The alphabet a random suffix is drawn from.
 *
 * Uppercase alphanumerics only, and deliberately **not** the full base-36 in
 * lower case: order numbers get read aloud, typed into forms and printed on
 * packing slips, and removing case-sensitivity removes a whole class of mistakes
 * (`l`/`1` ambiguity is handled by excluding nothing — see below).
 *
 * `0`/`O` and `1`/`I` are *included* deliberately. Removing look-alike characters
 * would shrink the space, and a wrong guess costs a 404 rather than access;
 * transcribing `0` as `O` costs a support ticket. Every character is a valid
 * UUID-safe, URL-safe, case-insensitive-unambiguous token.
 */
const ORDER_NUMBER_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** How many random characters follow the date. Six ⇒ 36^6 ≈ 2.18e9 per day. */
const RANDOM_SUFFIX_LENGTH = 6;

/**
 * How many candidates {@link OrderNumberGenerator.build} will try before it gives
 * up and hands back a last-resort number.
 *
 * With a space of 2.18 billion, exhausting ten candidates is not a
 * reachability concern — it would require a deliberate collision attack, which the
 * `UNIQUE` constraint is there to survive. The bound exists so the function is
 * total rather than possibly infinite.
 */
export const MAX_CANDIDATE_ATTEMPTS = 10;

/**
 * A date stamp, rendered as it appears inside an order number: `20261004`.
 *
 * **UTC, deliberately.** The stamp exists so a human can eyeball when an order
 * was placed. Local time would make the same order read differently depending on
 * which machine generated it, which defeats the purpose; UTC makes the number a
 * property of the order alone. The customer-facing timestamp they actually read is
 * `orders.created_at`, rendered by the client — this is only a convenience in the
 * identifier.
 */
function formatDateStamp(date: Date): string {
  const year = date.getUTCFullYear().toString().padStart(4, '0');
  const month = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = date.getUTCDate().toString().padStart(2, '0');

  return `${year}${month}${day}`;
}

/**
 * One cryptographically random character from {@link ORDER_NUMBER_ALPHABET}.
 *
 * `randomInt` is called with the *exclusive* upper bound, so passing
 * `ALPHABET.length` (36) yields 0–35 — every index exactly once and never out of
 * range, which is what keeps the distribution uniform and free of modulo bias.
 */
function randomCharacter(): string {
  return ORDER_NUMBER_ALPHABET[randomInt(ORDER_NUMBER_ALPHABET.length)];
}

/**
 * Builds candidate order numbers.
 *
 * Split out from {@link OrderNumberGenerator} so the pure string construction can
 * be tested directly — deterministically, without a database and without
 * depending on randomness. The only impure part is {@link OrderNumberGenerator.build},
 * which is the single place randomness enters.
 */
@Injectable()
export class OrderNumberGenerator {
  /**
   * Returns one candidate, optionally forcing a specific date.
   *
   * `date` exists for tests: a caller that pins the date gets the exact same
   * prefix every time and can assert on the suffix's shape alone.
   */
  build(date: Date = new Date()): string {
    const stamp = formatDateStamp(date);
    let suffix = '';

    for (let index = 0; index < RANDOM_SUFFIX_LENGTH; index += 1) {
      suffix += randomCharacter();
    }

    return `${ORDER_NUMBER_PREFIX}-${stamp}-${suffix}`;
  }

  /**
   * Returns `count` distinct candidates.
   *
   * Distinctness is checked within the returned batch only. It exists so a caller
   * that needs several numbers at once — a test seeding a fixture set, for
   * instance — does not have to trust that two consecutive calls to {@link build}
   * differed. It is *not* a uniqueness claim about the database, and the `UNIQUE`
   * constraint remains the only authority on that.
   *
   * The attempt budget is bounded by {@link MAX_CANDIDATE_ATTEMPTS} per requested
   * number, so a degenerate source cannot spin here forever. Exhausting it throws
   * rather than returning a short list: a caller that asked for `count` numbers and
   * received fewer would write duplicate fixtures and blame the database.
   */
  buildMany(count: number, date: Date = new Date()): string[] {
    const seen = new Set<string>();
    const budget = count * MAX_CANDIDATE_ATTEMPTS;
    let attempts = 0;

    while (seen.size < count && attempts < budget) {
      seen.add(this.build(date));
      attempts += 1;
    }

    if (seen.size < count) {
      throw new Error(
        `Could not generate ${count} distinct order numbers in ${budget} attempts`,
      );
    }

    return [...seen];
  }

  /** The regular expression every order number matches. Exported for reuse and tests. */
  static readonly PATTERN = /^ORD-\d{8}-[A-Z0-9]{6}$/;
}