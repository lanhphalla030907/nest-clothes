import { Injectable } from '@nestjs/common';
import { Prisma, type Promotion } from '../generated/prisma/client.js';
import {
  calculateOrderTotal,
  toNonNegativeDecimal,
} from '../orders/utils/order-money.js';
import {
  DISCOUNT_TYPE,
  PROMOTION_KIND,
  type DiscountType,
} from './constants/promotion.constants.js';
import { PromotionsRepository } from './repositories/promotions.repository.js';
import { normalizePromotionCode } from './utils/promotion-code.js';

/**
 * The cart facts the evaluator needs.
 *
 * `subtotal` is the product subtotal **before any discount and excluding
 * shipping**. That is the base both the minimum-spend rule and percentage/fixed
 * discounts use. `shippingFee` is the undiscounted fee from the selected
 * provider; a free-shipping promotion leaves the fee on the order and subtracts
 * an equal amount instead.
 *
 * `now` is injectable for tests. In production checkout omits it, and the
 * evaluator reads the clock once so every candidate in one evaluation sees the
 * same instant.
 */
export interface EvaluatePromotionsInput {
  userId: string;
  subtotal: string | number | Prisma.Decimal;
  shippingFee: string | number | Prisma.Decimal;
  couponCode?: string | null;
  now?: Date;
}

/**
 * What one applied promotion looked like at the moment it was evaluated.
 *
 * This is the shape intended for `checkout_quotes.applied_promotions` and the
 * order's historical description: identifiers and descriptive values are copied
 * in, and every amount is a two-decimal string so JSON storage cannot round it.
 * Editing the promotion later must not rewrite this record.
 */
export interface AppliedPromotionSnapshot {
  promotionId: string;
  code: string | null;
  name: string;
  discountType: string;
  percentOff: string | null;
  amountOff: string | null;
  discountAmount: string;
  subtotalAtUse: string;
}

/**
 * The complete priced outcome.
 *
 * `discountAmount` is the sum of `coupon` and `automatic` after the final
 * non-negative-total cap. The two named fields are the two stacking slots; no
 * other automatic promotion can appear in `automatic` or
 * `appliedPromotions`.
 */
export interface PromotionEvaluationResult {
  subtotal: Prisma.Decimal;
  shippingFee: Prisma.Decimal;
  discountAmount: Prisma.Decimal;
  totalAmount: Prisma.Decimal;
  coupon: AppliedPromotionSnapshot | null;
  automatic: AppliedPromotionSnapshot | null;
  appliedPromotions: AppliedPromotionSnapshot[];
}

/** A candidate plus the arithmetic value the selection compares. */
interface EvaluatedCandidate {
  promotion: Promotion;
  discountAmount: Prisma.Decimal;
  subtotalAtUse: Prisma.Decimal;
}

/**
 * Evaluates manual coupons and automatic promotions for one cart.
 *
 * ## The two slots
 *
 * A customer may use **one coupon and one automatic promotion**. Automatic
 * promotions do not stack with each other: the best single qualifying rule wins,
 * with `priority DESC` breaking an equal-discount tie. This service never
 * consumes usage; it only reports what would apply. Checkout integrates the
 * consumption inside its own transaction in a later phase.
 *
 * ## Transaction compatibility
 *
 * Every database read goes through {@link PromotionsRepository} with the caller's
 * `Prisma.TransactionClient`. The evaluator opens no transaction. Passing the
 * transaction is what makes the usage counts and the eventual usage write see
 * one consistent snapshot.
 *
 * ## Arithmetic
 *
 * All money is `Prisma.Decimal`. Percentage discounts round
 * `ROUND_HALF_UP` to two decimal places. Percentage and fixed discounts are
 * capped at the product subtotal; free shipping is capped at the shipping fee.
 * A final cap at `subtotal + shippingFee` guarantees the result cannot be
 * negative even when a coupon and an automatic promotion both qualify.
 */
@Injectable()
export class PromotionEvaluatorService {
  constructor(private readonly promotionsRepository: PromotionsRepository) {}

  async evaluate(
    input: EvaluatePromotionsInput,
    client?: Prisma.TransactionClient,
  ): Promise<PromotionEvaluationResult> {
    const subtotal = this.money(input.subtotal, 'subtotal');
    const shippingFee = this.money(input.shippingFee, 'shippingFee');
    const now = input.now ?? new Date();

    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new Error('now must be a valid Date');
    }

    const couponCode = normalizePromotionCode(input.couponCode);
    const coupon = await this.evaluateCoupon(
      couponCode,
      input.userId,
      subtotal,
      shippingFee,
      now,
      client,
    );
    const automatic = await this.selectBestAutomatic(
      input.userId,
      subtotal,
      shippingFee,
      now,
      client,
    );

    return this.combine(subtotal, shippingFee, coupon, automatic);
  }

  /** Looks up one coupon by its normalised code and evaluates it. */
  private async evaluateCoupon(
    code: string | null,
    userId: string,
    subtotal: Prisma.Decimal,
    shippingFee: Prisma.Decimal,
    now: Date,
    client?: Prisma.TransactionClient,
  ): Promise<EvaluatedCandidate | null> {
    if (code === null) {
      return null;
    }

    const promotion = await this.promotionsRepository.findByCode(code, client);

    if (promotion === null || promotion.kind !== PROMOTION_KIND.COUPON) {
      return null;
    }

    return this.evaluateCandidate(
      promotion,
      userId,
      subtotal,
      shippingFee,
      now,
      client,
    );
  }

  /**
   * Selects the single best automatic promotion.
   *
   * Candidates are evaluated sequentially rather than in `Promise.all`: when a
   * `Prisma.TransactionClient` is supplied, all reads belong to one transaction,
   * and a deterministic read order keeps usage-limit checks easy to reason
   * about. The set of automatic promotions is small by construction.
   */
  private async selectBestAutomatic(
    userId: string,
    subtotal: Prisma.Decimal,
    shippingFee: Prisma.Decimal,
    now: Date,
    client?: Prisma.TransactionClient,
  ): Promise<EvaluatedCandidate | null> {
    const promotions = await this.promotionsRepository.findAutomaticCandidates(
      subtotal.toFixed(2),
      now,
      client,
    );

    const candidates: EvaluatedCandidate[] = [];

    for (const promotion of promotions) {
      if (promotion.kind !== PROMOTION_KIND.AUTOMATIC) {
        continue;
      }

      const evaluated = await this.evaluateCandidate(
        promotion,
        userId,
        subtotal,
        shippingFee,
        now,
        client,
      );

      if (evaluated !== null) {
        candidates.push(evaluated);
      }
    }

    if (candidates.length === 0) {
      return null;
    }

    candidates.sort((left, right) => {
      const byDiscount = right.discountAmount.cmp(left.discountAmount);
      if (byDiscount !== 0) return byDiscount;

      const byPriority = right.promotion.priority - left.promotion.priority;
      if (byPriority !== 0) return byPriority;

      // Fully deterministic fallback for equal discount and priority. It is not
      // a business rule, just a guarantee that two identical evaluations pick
      // the same promotion.
      const byCreatedAt =
        left.promotion.createdAt.getTime() -
        right.promotion.createdAt.getTime();
      if (byCreatedAt !== 0) return byCreatedAt;

      return left.promotion.id.localeCompare(right.promotion.id);
    });

    return candidates[0] ?? null;
  }

  /**
   * Applies every eligibility rule and prices one promotion.
   *
   * A promotion that is paused, archived, outside its window, below its minimum
   * spend, over a usage limit, or a zero-value rule is not a candidate. Returning
   * `null` rather than throwing is deliberate: one invalid promotion must not
   * break a checkout that has other valid options.
   *
   * The feed from the repository already filters several of these in SQL. The
   * checks are repeated here so the rule is correct for any caller and any
   * future query change.
   */
  private async evaluateCandidate(
    promotion: Promotion,
    userId: string,
    subtotal: Prisma.Decimal,
    shippingFee: Prisma.Decimal,
    now: Date,
    client?: Prisma.TransactionClient,
  ): Promise<EvaluatedCandidate | null> {
    if (!this.isWithinWindow(promotion, subtotal, now)) {
      return null;
    }

    if (!(await this.isWithinUsageLimits(promotion, userId, client))) {
      return null;
    }

    const discountAmount = this.calculateDiscount(
      promotion,
      subtotal,
      shippingFee,
    );

    if (discountAmount === null || discountAmount.lte(0)) {
      return null;
    }

    return { promotion, discountAmount, subtotalAtUse: subtotal };
  }

  /**
   * Whether the promotion is currently allowed to apply.
   *
   * `startsAt` and `endsAt` are both inclusive. That matches the SQL candidate
   * query and gives an operator the intuitive "valid through the end timestamp"
   * behaviour. Pausing (`isActive`) and archiving are independent of the dates.
   */
  private isWithinWindow(
    promotion: Promotion,
    subtotal: Prisma.Decimal,
    now: Date,
  ): boolean {
    if (!promotion.isActive || promotion.archivedAt !== null) {
      return false;
    }

    if (
      promotion.startsAt !== null &&
      now.getTime() < promotion.startsAt.getTime()
    ) {
      return false;
    }

    if (
      promotion.endsAt !== null &&
      now.getTime() > promotion.endsAt.getTime()
    ) {
      return false;
    }

    return subtotal.gte(promotion.minSubtotal);
  }

  /**
   * Reads the two usage counters through the caller's transaction.
   *
   * The counters are only queried when a limit exists. A limit of `0` is
   * meaningful: nothing may consume the promotion, so the first check already
   * makes it ineligible.
   */
  private async isWithinUsageLimits(
    promotion: Promotion,
    userId: string,
    client?: Prisma.TransactionClient,
  ): Promise<boolean> {
    if (promotion.usageLimitTotal !== null) {
      const total = await this.promotionsRepository.countUsages(
        promotion.id,
        client,
      );
      if (total >= promotion.usageLimitTotal) {
        return false;
      }
    }

    if (promotion.usageLimitPerUser !== null) {
      const usedByUser = await this.promotionsRepository.countUsagesForUser(
        promotion.id,
        userId,
        client,
      );
      if (usedByUser >= promotion.usageLimitPerUser) {
        return false;
      }
    }

    return true;
  }

  /**
   * Prices one promotion against the cart.
   *
   * `PERCENTAGE`: `subtotal × percentOff ÷ 100`, rounded half-up to cents.
   * `FIXED_AMOUNT`: `min(amountOff, subtotal)`.
   * `FREE_SHIPPING`: the original shipping fee.
   *
   * Every type then applies `maxDiscount` when present and is capped at the base
   * it is allowed to discount. An unknown type (which the database `CHECK`
   * should prevent) yields `null`, not an exception.
   */
  private calculateDiscount(
    promotion: Promotion,
    subtotal: Prisma.Decimal,
    shippingFee: Prisma.Decimal,
  ): Prisma.Decimal | null {
    let discount: Prisma.Decimal;
    let base: Prisma.Decimal;

    switch (promotion.discountType as DiscountType) {
      case DISCOUNT_TYPE.PERCENTAGE:
        if (promotion.percentOff === null) {
          return null;
        }

        discount = subtotal
          .mul(promotion.percentOff)
          .div(100)
          .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
        base = subtotal;
        break;

      case DISCOUNT_TYPE.FIXED_AMOUNT:
        if (promotion.amountOff === null) {
          return null;
        }

        discount = promotion.amountOff.lt(subtotal)
          ? promotion.amountOff
          : subtotal;
        base = subtotal;
        break;

      case DISCOUNT_TYPE.FREE_SHIPPING:
        discount = shippingFee;
        base = shippingFee;
        break;

      default:
        return null;
    }

    if (promotion.maxDiscount !== null && discount.gt(promotion.maxDiscount)) {
      discount = promotion.maxDiscount;
    }

    if (discount.gt(base)) {
      discount = base;
    }

    return discount.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  }

  /**
   * Combines the two slots and enforces the non-negative-total invariant.
   *
   * Each promotion is already capped by its own base, but a coupon and an
   * automatic promotion can still exceed `subtotal + shippingFee` together. The
   * excess is removed from the automatic promotion first, then from the coupon,
   * so a customer-entered coupon is preserved where possible. A promotion
   * reduced to zero is dropped from the result entirely rather than reported as
   * "applied" with no effect.
   */
  private combine(
    subtotal: Prisma.Decimal,
    shippingFee: Prisma.Decimal,
    couponCandidate: EvaluatedCandidate | null,
    automaticCandidate: EvaluatedCandidate | null,
  ): PromotionEvaluationResult {
    let coupon = couponCandidate;
    let automatic = automaticCandidate;
    let totalDiscount = this.sumDiscounts(coupon, automatic);
    const maximumDiscount = subtotal.plus(shippingFee);

    if (totalDiscount.gt(maximumDiscount)) {
      let excess = totalDiscount.minus(maximumDiscount);

      if (automatic !== null) {
        const original = automatic.discountAmount;
        automatic = this.reduceCandidate(automatic, excess);
        const removed = original.minus(
          automatic === null ? new Prisma.Decimal(0) : automatic.discountAmount,
        );
        excess = excess.minus(removed);
      }

      if (excess.gt(0) && coupon !== null) {
        const original = coupon.discountAmount;
        coupon = this.reduceCandidate(coupon, excess);
        const removed = original.minus(
          coupon === null ? new Prisma.Decimal(0) : coupon.discountAmount,
        );
        excess = excess.minus(removed);
      }

      totalDiscount = this.sumDiscounts(coupon, automatic);
    }

    const totalAmount = calculateOrderTotal(
      subtotal,
      shippingFee,
      totalDiscount,
    );

    const couponSnapshot = coupon === null ? null : this.toSnapshot(coupon);
    const automaticSnapshot =
      automatic === null ? null : this.toSnapshot(automatic);

    const appliedPromotions: AppliedPromotionSnapshot[] = [];
    if (couponSnapshot !== null) appliedPromotions.push(couponSnapshot);
    if (automaticSnapshot !== null) appliedPromotions.push(automaticSnapshot);

    return {
      subtotal,
      shippingFee,
      discountAmount: totalDiscount,
      totalAmount,
      coupon: couponSnapshot,
      automatic: automaticSnapshot,
      appliedPromotions,
    };
  }

  /**
   * Reduces one candidate by at most `excess`; returns `null` when it reaches
   * zero. The caller recomputes the removed amount from the returned candidate.
   */
  private reduceCandidate(
    candidate: EvaluatedCandidate,
    excess: Prisma.Decimal,
  ): EvaluatedCandidate | null {
    const reduction = candidate.discountAmount.lt(excess)
      ? candidate.discountAmount
      : excess;
    const remaining = candidate.discountAmount.minus(reduction);

    if (remaining.lte(0)) {
      return null;
    }

    return { ...candidate, discountAmount: remaining };
  }

  private sumDiscounts(
    first: EvaluatedCandidate | null,
    second: EvaluatedCandidate | null,
  ): Prisma.Decimal {
    const firstAmount =
      first === null ? new Prisma.Decimal(0) : first.discountAmount;
    const secondAmount =
      second === null ? new Prisma.Decimal(0) : second.discountAmount;
    return firstAmount.plus(secondAmount);
  }

  private toSnapshot(candidate: EvaluatedCandidate): AppliedPromotionSnapshot {
    return {
      promotionId: candidate.promotion.id,
      code: candidate.promotion.code,
      name: candidate.promotion.name,
      discountType: candidate.promotion.discountType,
      percentOff:
        candidate.promotion.percentOff === null
          ? null
          : candidate.promotion.percentOff.toFixed(2),
      amountOff:
        candidate.promotion.amountOff === null
          ? null
          : candidate.promotion.amountOff.toFixed(2),
      discountAmount: candidate.discountAmount.toFixed(2),
      subtotalAtUse: candidate.subtotalAtUse.toFixed(2),
    };
  }

  /** Parses and normalises a money input to the two-decimal order scale. */
  private money(value: unknown, field: string): Prisma.Decimal {
    return toNonNegativeDecimal(value, field).toDecimalPlaces(
      2,
      Prisma.Decimal.ROUND_HALF_UP,
    );
  }
}
