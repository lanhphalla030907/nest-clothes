import { randomInt } from 'node:crypto';
import type { Mock } from 'vitest';
import { PAYWAY_MAX_TRANSACTION_ID_LENGTH } from './payway/payway.constants.js';
import { isValidPaywayTransactionId } from './payway/payway-hash.js';
import { TransactionIdGenerator } from './payment-transaction-id.generator.js';

vi.mock('node:crypto', () => ({ randomInt: vi.fn() }));

const randomIntMock = randomInt as unknown as Mock<(max: number) => number>;

/**
 * The transaction id is the one value this application and PayWay must agree on
 * exactly, in every request, forever. Three properties are load-bearing:
 *
 * - **within PayWay's 20-character limit**, because a longer id is refused by the
 *   provider and every payment fails;
 * - **unique**, so two payments can never be confused for one another — which is
 *   ultimately enforced by the database, not here;
 * - **unguessable**, so an unauthenticated prober cannot walk the id space and read
 *   somebody else's payment status through the webhook.
 */
describe('TransactionIdGenerator', () => {
  const generator = new TransactionIdGenerator();
  const date = new Date('2026-10-04T15:30:07.000Z');

  beforeEach(() => {
    randomIntMock.mockReset();
  });

  describe('build', () => {
    it('renders PW-YYMMDDHHMMSS-XXXXXX in UTC', () => {
      randomIntMock.mockReturnValue(0);

      expect(generator.build(date)).toBe('PW261004153007AAAAAA');
    });

    it('matches its own published pattern', () => {
      randomIntMock.mockReturnValue(0);

      expect(generator.build(date)).toMatch(TransactionIdGenerator.PATTERN);
    });

    it('fills PayWay maximum length exactly', () => {
      randomIntMock.mockReturnValue(35);

      const id = generator.build(date);

      expect(id).toHaveLength(PAYWAY_MAX_TRANSACTION_ID_LENGTH);
    });

    it('is a value PayWay would accept', () => {
      randomIntMock.mockReturnValue(7);

      // The generator is the only producer of these strings, so if it can emit one the
      // gateway would refuse, every payment it mints is dead on arrival.
      expect(isValidPaywayTransactionId(generator.build(date))).toBe(true);
    });

    it('stamps UTC, not the local zone', () => {
      randomIntMock.mockReturnValue(0);
      // Late-evening UTC is already the next day in any positive-offset zone, and
      // PayWay validates the request-time window — a local stamp would look like a
      // request from the future.
      const lateEvening = new Date('2026-10-04T23:30:07.000Z');
      const earlyMorning = new Date('2026-10-05T01:30:07.000Z');

      expect(generator.build(lateEvening)).toBe('PW261004233007AAAAAA');
      expect(generator.build(earlyMorning)).toBe('PW261005013007AAAAAA');
    });

    it('pads every timestamp component', () => {
      randomIntMock.mockReturnValue(0);

      expect(generator.build(new Date('2026-01-02T03:04:05.000Z'))).toBe(
        'PW260102030405AAAAAA',
      );
    });

    it('takes the last two digits of a four-digit year', () => {
      randomIntMock.mockReturnValue(0);

      expect(generator.build(new Date('2099-12-31T23:59:59.000Z'))).toBe(
        'PW991231235959AAAAAA',
      );
    });

    it('draws every character from the full alphabet', () => {
      // Highest index only: `randomInt` is called with an exclusive bound, so this is the
      // last valid character. If the bound were off by one the call would throw.
      randomIntMock.mockReturnValue(35);

      expect(generator.build(date)).toContain('9');
      expect(randomIntMock).toHaveBeenCalledWith(36);
    });

    it('calls the random source exactly six times, once per character', () => {
      randomIntMock.mockReturnValue(0);

      generator.build(date);

      expect(randomIntMock).toHaveBeenCalledTimes(6);
    });

    it('defaults to the current time', () => {
      randomIntMock.mockReturnValue(0);

      expect(generator.build()).toMatch(TransactionIdGenerator.PATTERN);
    });
  });

  describe('distinctness across many builds', () => {
    /**
     * Feeds a distinct six-character suffix on each build.
     *
     * The step has to advance once per *character*, not once per call: six `randomInt`
     * calls make one id. Driving the source rather than leaving it real is deliberate —
     * `node:crypto` is not what is under test here, and the assertions above already
     * prove the generator uses it with the right bound and call count.
     */
    const sequentialSuffixes = () => {
      let call = 0;

      vi.mocked(randomInt).mockImplementation(() => {
        call += 1;
        return Math.floor((call - 1) / 6) % 36;
      });
    };

    it('produces a different id every time', () => {
      sequentialSuffixes();

      const ids = new Set<string>();

      for (let index = 0; index < 36; index += 1) {
        ids.add(generator.build(date));
      }

      expect(ids.size).toBe(36);
    });

    it('keeps every id inside PayWay limit', () => {
      sequentialSuffixes();

      for (let index = 0; index < 36; index += 1) {
        const id = generator.build(date);

        expect(id.length).toBeLessThanOrEqual(PAYWAY_MAX_TRANSACTION_ID_LENGTH);
        expect(isValidPaywayTransactionId(id)).toBe(true);
      }
    });

    it('differs by timestamp even when the suffix repeats', () => {
      // Two payments one second apart must not collide even if the random source were to
      // return the same six characters, which is exactly the case the timestamp covers.
      randomIntMock.mockReturnValue(0);

      const first = generator.build(new Date('2026-10-04T15:30:07.000Z'));
      const second = generator.build(new Date('2026-10-04T15:30:08.000Z'));

      expect(first).not.toBe(second);
      expect(first.slice(0, 14)).toBe('PW261004153007');
      expect(second.slice(0, 14)).toBe('PW261004153008');
    });
  });
});
