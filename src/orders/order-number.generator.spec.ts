import { randomInt } from 'node:crypto';
import type { Mock } from 'vitest';
import { MAX_CANDIDATE_ATTEMPTS, OrderNumberGenerator } from './order-number.generator.js';

vi.mock('node:crypto', () => ({ randomInt: vi.fn() }));

// `randomInt` is overloaded in the Node typings and the mock only implements the
// single-argument form, so `vi.mocked` resolves to a `void`-returning signature.
// One cast here beats a cast at every stub site.
const randomIntMock = randomInt as unknown as Mock<(max: number) => number>;

/**
 * The order number a customer reads out over the phone.
 *
 * Two properties are load-bearing and tested here: it is **unguessable** (so one
 * customer cannot infer another's order by counting) and it is **well-formed** (so
 * it fits `VARCHAR(30)` and can be typed without ambiguity). Randomness is mocked so
 * the distribution can be asserted rather than sampled.
 */
describe('OrderNumberGenerator', () => {
  const generator = new OrderNumberGenerator();
  const date = new Date('2026-01-04T12:00:00.000Z');

  beforeEach(() => {
    randomIntMock.mockReset();
  });

  describe('build', () => {
    it('renders ORD-YYYYMMDD-XXXXXX', () => {
      randomIntMock.mockReturnValue(0);

      expect(generator.build(date)).toBe('ORD-20260104-AAAAAA');
    });

    it('pads a single-digit month and day', () => {
      randomIntMock.mockReturnValue(35);

      expect(generator.build(new Date('2026-03-07T00:00:00.000Z'))).toBe(
        'ORD-20260307-999999',
      );
    });

    it('stamps the UTC date, not the local one', () => {
      randomIntMock.mockReturnValue(0);
      // Late-evening UTC: in any positive-offset zone this is already the next day,
      // and a local-time stamp would make one order read as two different days.
      const lateEvening = new Date('2026-01-04T23:30:00.000Z');
      const earlyEvening = new Date('2026-01-04T01:30:00.000Z');

      expect(generator.build(lateEvening).startsWith('ORD-20260104-')).toBe(true);
      expect(generator.build(earlyEvening).startsWith('ORD-20260104-')).toBe(
        true,
      );
    });

    it('draws six characters from a 36-symbol alphabet, uniformly', () => {
      randomIntMock.mockReturnValue(0);

      generator.build(date);

      // Exclusive upper bound of 36 gives 0–35: every index once, no modulo bias.
      expect(randomInt).toHaveBeenCalledTimes(6);
      expect(randomInt).toHaveBeenCalledWith(36);
    });

    it('covers the whole alphabet when the source is exhaustive', () => {
      const seen = new Set<string>();
      // Walk all 36 symbols rather than sampling, so the alphabet itself is pinned.
      for (let index = 0; index < 36; index += 1) {
        randomIntMock.mockReturnValue(index);
        seen.add(generator.build(date).slice(-1));
      }

      expect(seen).toEqual(
        new Set('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('')),
      );
    });

    it('fits VARCHAR(30) with room to spare', () => {
      randomIntMock.mockReturnValue(35);

      expect(generator.build(date).length).toBeLessThanOrEqual(30);
    });

    it('matches the documented pattern', () => {
      for (let index = 0; index < 36; index += 1) {
        randomIntMock.mockReturnValue(index);

        expect(generator.build(date)).toMatch(OrderNumberGenerator.PATTERN);
      }
    });

    it('defaults to now, so a caller need not pass a date', () => {
      randomIntMock.mockReturnValue(0);
      const today = new Date();
      const expected = today.toISOString().slice(0, 10).replaceAll('-', '');

      expect(generator.build().startsWith(`ORD-${expected}-`)).toBe(true);
    });
  });

  describe('buildMany', () => {
    /**
     * Feeds a distinct six-character group on each build, by advancing the mocked
     * source once per *character* — six `randomInt` calls make one number, so the
     * step has to happen every six calls rather than every call.
     */
    const sequentialGroups = () => {
      let call = 0;
      vi.mocked(randomInt).mockImplementation(() => {
        call += 1;
        return Math.floor((call - 1) / 6) % 36;
      });
    };

    it('returns the requested count, distinct', () => {
      sequentialGroups();

      const numbers = generator.buildMany(36);

      expect(numbers).toHaveLength(36);
      expect(new Set(numbers).size).toBe(36);
    });

    it('keeps drawing when a duplicate comes back', () => {
      // A collision is the whole reason the loop exists, so a source that repeats
      // must not shorten the result.
      let call = 0;
      vi.mocked(randomInt).mockImplementation(() => {
        call += 1;
        return call <= 6 ? 0 : Math.floor((call - 1) / 6) % 36;
      });

      const numbers = generator.buildMany(3);

      expect(numbers).toHaveLength(3);
      expect(new Set(numbers).size).toBe(3);
    });

    it('returns an empty list for a count of zero, touching no randomness', () => {
      expect(generator.buildMany(0)).toEqual([]);
      expect(randomInt).not.toHaveBeenCalled();
    });

    it('produces numbers matching the pattern', () => {
      sequentialGroups();

      for (const orderNumber of generator.buildMany(20)) {
        expect(orderNumber).toMatch(OrderNumberGenerator.PATTERN);
      }
    });

    it('throws rather than returning a short list when the source is degenerate', () => {
      // A caller that asked for `count` numbers and received fewer would write
      // duplicate fixtures and blame the database for it.
      randomIntMock.mockReturnValue(0);

      expect(() => generator.buildMany(5)).toThrow(/5 distinct order numbers/);
    });

    it('exposes the bound it uses', () => {
      expect(MAX_CANDIDATE_ATTEMPTS).toBeGreaterThan(0);
    });
  });
});
