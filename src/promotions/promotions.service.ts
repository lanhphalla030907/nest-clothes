import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type Promotion } from '../generated/prisma/client.js';
import { normalizeMoney } from '../common/utils/normalize-money.js';
import {
  DISCOUNT_TYPE,
  DISCOUNT_TYPES,
  MAX_PERCENTAGE,
  MAX_PROMOTION_PAGE_SIZE,
  PROMOTION_KIND,
  PROMOTION_KINDS,
  type DiscountType,
  type PromotionKind,
} from './constants/promotion.constants.js';
import { PROMOTION_MESSAGES } from './constants/promotion-error-messages.js';
import { CreatePromotionDto } from './dto/create-promotion.dto.js';
import { PromotionListQueryDto } from './dto/promotion-list-query.dto.js';
import { PromotionListResponseDto } from './dto/promotion-list-response.dto.js';
import { PromotionResponseDto } from './dto/promotion-response.dto.js';
import { PromotionUsageListQueryDto } from './dto/promotion-usage-list-query.dto.js';
import { PromotionUsageListResponseDto } from './dto/promotion-usage-list-response.dto.js';
import { UpdatePromotionDto } from './dto/update-promotion.dto.js';
import {
  PromotionsRepository,
  type CreatePromotionData,
  type UpdatePromotionData,
} from './repositories/promotions.repository.js';
import { normalizePromotionCode } from './utils/promotion-code.js';

/** `NUMERIC(12,2)` allows ten integer digits and two fraction digits. */
const MAX_MONEY = new Prisma.Decimal('9999999999.99');
const MONEY_PATTERN = /^\d{1,10}\.\d{2}$/;
const CODE_MAX_LENGTH = 50;
const NAME_MAX_LENGTH = 120;
const DESCRIPTION_MAX_LENGTH = 500;
const SEARCH_MAX_LENGTH = 200;

/** The fully-resolved shape a create or update is about to write. */
interface PromotionShape {
  code: string | null;
  name: string;
  description: string | null;
  kind: string;
  discountType: string;
  percentOff: Prisma.Decimal | null;
  amountOff: Prisma.Decimal | null;
  minSubtotal: Prisma.Decimal;
  maxDiscount: Prisma.Decimal | null;
  startsAt: Date | null;
  endsAt: Date | null;
  isActive: boolean;
  usageLimitTotal: number | null;
  usageLimitPerUser: number | null;
  priority: number;
}

/**
 * Owns the rules about what a promotion may be.
 *
 * This phase exposes no HTTP route. The methods exist so the future admin
 * controller and, later, checkout integration have one place that validates and
 * writes a promotion, instead of each caller re-implementing the same checks.
 *
 * ## Validation is here, not only in the DTO
 *
 * A DTO only runs when a request passes through Nest's `ValidationPipe`. A
 * service call from another service does not, so every rule is repeated here.
 * The database `CHECK` constraints are the final backstop, but a caller should
 * receive a deterministic 400 rather than a constraint violation.
 *
 * ## Update merges before it validates
 *
 * A partial update can change `discountType` without naming the fields of the
 * new type. The service therefore resolves the *resulting* promotion first,
 * clears fields that no longer belong to the type, and validates the whole
 * shape. It never sends a row whose stored values contradict its type.
 */
@Injectable()
export class PromotionsService {
  constructor(private readonly promotionsRepository: PromotionsRepository) {}

  async create(dto: CreatePromotionDto): Promise<PromotionResponseDto> {
    const kind = this.promotionKind(dto.kind);
    const discountType = this.discountType(dto.discountType);
    this.assertDiscountFieldsMatchType(discountType, dto);
    const code = this.resolveCreateCode(kind, dto.code);
    const name = this.name(dto.name);
    const description = this.description(dto.description);
    const percentOff = this.discountPercent(dto.percentOff);
    const amountOff = this.discountAmount(dto.amountOff);
    const minSubtotal = this.minSubtotal(dto.minSubtotal);
    const maxDiscount = this.maxDiscount(dto.maxDiscount);
    const startsAt = this.date(dto.startsAt, 'startsAt');
    const endsAt = this.date(dto.endsAt, 'endsAt');
    const usageLimitTotal = this.usageLimit(
      dto.usageLimitTotal,
      'usageLimitTotal',
    );
    const usageLimitPerUser = this.usageLimit(
      dto.usageLimitPerUser,
      'usageLimitPerUser',
    );
    const priority = this.priority(dto.priority ?? 0);

    const shape: PromotionShape = {
      code,
      name,
      description,
      kind,
      discountType,
      percentOff,
      amountOff,
      minSubtotal,
      maxDiscount,
      startsAt,
      endsAt,
      isActive: dto.isActive ?? true,
      usageLimitTotal,
      usageLimitPerUser,
      priority,
    };

    this.assertShape(shape);

    if (shape.code !== null) {
      await this.assertCodeAvailable(shape.code);
    }

    const data: CreatePromotionData = this.toCreateData(shape);

    try {
      const promotion = await this.promotionsRepository.create(data);
      return PromotionResponseDto.fromEntity(promotion);
    } catch (error) {
      this.rethrowAsHttpError(error);
    }
  }

  async update(
    id: string,
    dto: UpdatePromotionDto,
  ): Promise<PromotionResponseDto> {
    const existing = await this.requirePromotion(id);

    const kind = this.promotionKind(
      dto.kind === undefined ? existing.kind : dto.kind,
    );
    const discountType = this.discountType(
      dto.discountType === undefined ? existing.discountType : dto.discountType,
    );

    this.assertDiscountFieldsMatchType(discountType, dto);
    const code = this.resolveUpdateCode(kind, existing, dto.code);
    const name = dto.name === undefined ? existing.name : this.name(dto.name);
    const description =
      dto.description === undefined
        ? existing.description
        : this.description(dto.description);
    const percentOff = this.resolveUpdatePercent(
      discountType,
      existing,
      dto.percentOff,
      dto.percentOff !== undefined,
    );
    const amountOff = this.resolveUpdateAmount(
      discountType,
      existing,
      dto.amountOff,
      dto.amountOff !== undefined,
    );
    const minSubtotal =
      dto.minSubtotal === undefined
        ? existing.minSubtotal
        : this.minSubtotal(dto.minSubtotal);
    const maxDiscount =
      dto.maxDiscount === undefined
        ? existing.maxDiscount
        : this.maxDiscount(dto.maxDiscount);
    const startsAt =
      dto.startsAt === undefined
        ? existing.startsAt
        : this.date(dto.startsAt, 'startsAt');
    const endsAt =
      dto.endsAt === undefined
        ? existing.endsAt
        : this.date(dto.endsAt, 'endsAt');
    const usageLimitTotal =
      dto.usageLimitTotal === undefined
        ? existing.usageLimitTotal
        : this.usageLimit(dto.usageLimitTotal, 'usageLimitTotal');
    const usageLimitPerUser =
      dto.usageLimitPerUser === undefined
        ? existing.usageLimitPerUser
        : this.usageLimit(dto.usageLimitPerUser, 'usageLimitPerUser');
    const priority =
      dto.priority === undefined
        ? existing.priority
        : this.priority(dto.priority);

    const shape: PromotionShape = {
      code,
      name,
      description,
      kind,
      discountType,
      percentOff,
      amountOff,
      minSubtotal,
      maxDiscount,
      startsAt,
      endsAt,
      isActive: dto.isActive ?? existing.isActive,
      usageLimitTotal,
      usageLimitPerUser,
      priority,
    };

    this.assertShape(shape);

    if (shape.code !== null && shape.code !== existing.code) {
      await this.assertCodeAvailable(shape.code, existing.id);
    }

    const data: UpdatePromotionData = this.toCreateData(shape);

    try {
      const promotion = await this.promotionsRepository.update(id, data);
      return PromotionResponseDto.fromEntity(promotion);
    } catch (error) {
      this.rethrowAsHttpError(error);
    }
  }

  async findById(id: string): Promise<PromotionResponseDto> {
    return PromotionResponseDto.fromEntity(await this.requirePromotion(id));
  }

  async list(query: PromotionListQueryDto): Promise<PromotionListResponseDto> {
    this.assertPage(query.page, query.limit);

    const search = query.search?.trim();
    if (search !== undefined && search.length > SEARCH_MAX_LENGTH) {
      throw new BadRequestException(PROMOTION_MESSAGES.SEARCH_TOO_LONG);
    }

    const result = await this.promotionsRepository.findPage({
      page: query.page,
      limit: query.limit,
      kind:
        query.kind === undefined ? undefined : this.promotionKind(query.kind),
      discountType:
        query.discountType === undefined
          ? undefined
          : this.discountType(query.discountType),
      isActive: query.isActive,
      archived: query.archived,
      search: search === undefined || search.length === 0 ? undefined : search,
    });

    return PromotionListResponseDto.fromResult(result, query.page, query.limit);
  }

  async activate(id: string): Promise<PromotionResponseDto> {
    const promotion = await this.requirePromotion(id);

    if (promotion.archivedAt !== null) {
      throw new ConflictException(PROMOTION_MESSAGES.ARCHIVED_CANNOT_ACTIVATE);
    }

    if (promotion.isActive) {
      return PromotionResponseDto.fromEntity(promotion);
    }

    const updated = await this.promotionsRepository.update(id, {
      isActive: true,
    });
    return PromotionResponseDto.fromEntity(updated);
  }

  async pause(id: string): Promise<PromotionResponseDto> {
    const promotion = await this.requirePromotion(id);

    if (!promotion.isActive) {
      return PromotionResponseDto.fromEntity(promotion);
    }

    const updated = await this.promotionsRepository.update(id, {
      isActive: false,
    });
    return PromotionResponseDto.fromEntity(updated);
  }

  /**
   * Retires a promotion without deleting its history.
   *
   * The row and its usage ledger stay; `archivedAt` marks it as retired and
   * `isActive` is cleared so a stale activation cannot make it evaluable again.
   * A promotion that is already archived is returned unchanged, because archiving
   * twice should not move the retirement timestamp.
   */
  async archive(id: string): Promise<PromotionResponseDto> {
    const promotion = await this.requirePromotion(id);

    if (promotion.archivedAt !== null) {
      return PromotionResponseDto.fromEntity(promotion);
    }

    const updated = await this.promotionsRepository.update(id, {
      archivedAt: new Date(),
      isActive: false,
    });
    return PromotionResponseDto.fromEntity(updated);
  }

  async listUsages(
    promotionId: string,
    query: PromotionUsageListQueryDto,
  ): Promise<PromotionUsageListResponseDto> {
    await this.requirePromotion(promotionId);
    this.assertPage(query.page, query.limit);

    const result = await this.promotionsRepository.findUsagePage(promotionId, {
      page: query.page,
      limit: query.limit,
    });

    return PromotionUsageListResponseDto.fromResult(
      result,
      query.page,
      query.limit,
    );
  }

  private async requirePromotion(id: string): Promise<Promotion> {
    const promotion = await this.promotionsRepository.findById(id);
    if (promotion === null) {
      throw new NotFoundException(PROMOTION_MESSAGES.NOT_FOUND(id));
    }
    return promotion;
  }

  private promotionKind(value: string): PromotionKind {
    if (!PROMOTION_KINDS.includes(value as PromotionKind)) {
      throw new BadRequestException(PROMOTION_MESSAGES.KIND_INVALID);
    }
    return value as PromotionKind;
  }

  private discountType(value: string): DiscountType {
    if (!DISCOUNT_TYPES.includes(value as DiscountType)) {
      throw new BadRequestException(PROMOTION_MESSAGES.DISCOUNT_TYPE_INVALID);
    }
    return value as DiscountType;
  }

  private resolveCreateCode(
    kind: PromotionKind,
    value: string | null | undefined,
  ): string | null {
    const code = normalizePromotionCode(value);

    if (kind === PROMOTION_KIND.COUPON && code === null) {
      throw new BadRequestException(PROMOTION_MESSAGES.CODE_REQUIRED);
    }
    if (
      kind === PROMOTION_KIND.AUTOMATIC &&
      value !== undefined &&
      code !== null
    ) {
      throw new BadRequestException(PROMOTION_MESSAGES.CODE_NOT_ALLOWED);
    }
    if (code !== null && code.length > CODE_MAX_LENGTH) {
      throw new BadRequestException(PROMOTION_MESSAGES.CODE_TOO_LONG);
    }

    return code;
  }

  private resolveUpdateCode(
    kind: PromotionKind,
    existing: Promotion,
    value: string | null | undefined,
  ): string | null {
    if (value !== undefined) {
      const code = normalizePromotionCode(value);
      if (kind === PROMOTION_KIND.AUTOMATIC && code !== null) {
        throw new BadRequestException(PROMOTION_MESSAGES.CODE_NOT_ALLOWED);
      }
      if (code !== null && code.length > CODE_MAX_LENGTH) {
        throw new BadRequestException(PROMOTION_MESSAGES.CODE_TOO_LONG);
      }
      return code;
    }

    if (kind === PROMOTION_KIND.COUPON) {
      if (existing.code === null) {
        throw new BadRequestException(PROMOTION_MESSAGES.CODE_REQUIRED);
      }
      return existing.code;
    }

    // Switching to AUTOMATIC without naming a code clears the old coupon code.
    return null;
  }

  /**
   * Resolves the percentage a promotion will carry.
   *
   * When the type changed, a percentage left over from the old type is dropped
   * rather than carried across: a fixed-amount promotion's null percentage is
   * the value that must survive, not a stale one. An explicitly supplied
   * percentage for a non-percentage type is rejected before reaching here.
   */
  private resolveUpdatePercent(
    discountType: string,
    existing: Promotion,
    value: string | null | undefined,
    provided: boolean,
  ): Prisma.Decimal | null {
    if (discountType !== DISCOUNT_TYPE.PERCENTAGE) {
      return null;
    }

    if (provided) {
      return this.discountPercent(value);
    }

    return existing.percentOff;
  }

  private resolveUpdateAmount(
    discountType: string,
    existing: Promotion,
    value: string | null | undefined,
    provided: boolean,
  ): Prisma.Decimal | null {
    if (discountType !== DISCOUNT_TYPE.FIXED_AMOUNT) {
      return null;
    }

    if (provided) {
      return this.discountAmount(value);
    }

    return existing.amountOff;
  }

  private discountPercent(value: unknown): Prisma.Decimal | null {
    if (value === undefined || value === null || value === '') {
      return null;
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(trimmed)) {
        throw new BadRequestException(PROMOTION_MESSAGES.PERCENTAGE_RANGE);
      }
      value = trimmed;
    }

    const percent = this.decimal(value, PROMOTION_MESSAGES.PERCENTAGE_RANGE);
    if (percent.lte(0) || percent.gt(MAX_PERCENTAGE)) {
      throw new BadRequestException(PROMOTION_MESSAGES.PERCENTAGE_RANGE);
    }

    return percent.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  }

  private discountAmount(value: unknown): Prisma.Decimal | null {
    if (value === undefined || value === null || value === '') {
      return null;
    }

    const amount = this.money(value, PROMOTION_MESSAGES.FIXED_AMOUNT_POSITIVE);
    if (amount.lte(0)) {
      throw new BadRequestException(PROMOTION_MESSAGES.FIXED_AMOUNT_POSITIVE);
    }

    return amount;
  }

  private minSubtotal(value: unknown): Prisma.Decimal {
    if (value === undefined || value === null || value === '') {
      return new Prisma.Decimal(0);
    }
    return this.money(value, PROMOTION_MESSAGES.MIN_SUBTOTAL_NON_NEGATIVE);
  }

  private maxDiscount(value: unknown): Prisma.Decimal | null {
    if (value === undefined || value === null || value === '') {
      return null;
    }

    const amount = this.money(value, PROMOTION_MESSAGES.MAX_DISCOUNT_POSITIVE);
    if (amount.lte(0)) {
      throw new BadRequestException(PROMOTION_MESSAGES.MAX_DISCOUNT_POSITIVE);
    }
    return amount;
  }

  private money(value: unknown, message: string): Prisma.Decimal {
    if (value instanceof Prisma.Decimal) {
      if (!value.isFinite() || value.isNegative() || value.gt(MAX_MONEY)) {
        throw new BadRequestException(message);
      }
      return value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    }

    const normalized = normalizeMoney(value as string | number);
    if (typeof normalized !== 'string' || !MONEY_PATTERN.test(normalized)) {
      throw new BadRequestException(message);
    }

    const amount = new Prisma.Decimal(normalized);
    if (!amount.isFinite() || amount.isNegative() || amount.gt(MAX_MONEY)) {
      throw new BadRequestException(message);
    }
    return amount;
  }

  private decimal(value: unknown, message: string): Prisma.Decimal {
    try {
      const parsed =
        value instanceof Prisma.Decimal
          ? value
          : new Prisma.Decimal(String(value));
      if (!parsed.isFinite()) {
        throw new BadRequestException(message);
      }
      return parsed;
    } catch {
      throw new BadRequestException(message);
    }
  }

  private date(
    value: string | Date | null | undefined,
    field: string,
  ): Date | null {
    if (value === undefined || value === null || value === '') {
      return null;
    }

    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(
        `${field} ${PROMOTION_MESSAGES.DATE_INVALID}`,
      );
    }
    return date;
  }

  private usageLimit(value: unknown, field: string): number | null {
    if (value === undefined || value === null) {
      return null;
    }

    if (!Number.isInteger(value) || (value as number) < 0) {
      throw new BadRequestException(
        field === 'usageLimitTotal'
          ? PROMOTION_MESSAGES.USAGE_LIMIT_TOTAL_NON_NEGATIVE
          : PROMOTION_MESSAGES.USAGE_LIMIT_PER_USER_NON_NEGATIVE,
      );
    }
    return value as number;
  }

  private priority(value: unknown): number {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new BadRequestException(PROMOTION_MESSAGES.PRIORITY_INTEGER);
    }
    return value;
  }

  private name(value: unknown): string {
    if (typeof value !== 'string') {
      throw new BadRequestException(PROMOTION_MESSAGES.NAME_REQUIRED);
    }

    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new BadRequestException(PROMOTION_MESSAGES.NAME_REQUIRED);
    }
    if (trimmed.length > NAME_MAX_LENGTH) {
      throw new BadRequestException(PROMOTION_MESSAGES.NAME_TOO_LONG);
    }
    return trimmed;
  }

  private description(value: unknown): string | null {
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value !== 'string') {
      throw new BadRequestException(PROMOTION_MESSAGES.DESCRIPTION_TOO_LONG);
    }

    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return null;
    }
    if (trimmed.length > DESCRIPTION_MAX_LENGTH) {
      throw new BadRequestException(PROMOTION_MESSAGES.DESCRIPTION_TOO_LONG);
    }
    return trimmed;
  }

  /**
   * Rejects a discount field that was explicitly sent for a different type.
   *
   * Clearing an old type's field during an update is correct; letting a caller
   * send `amountOff` on a percentage promotion and silently ignore it is not.
   */
  private assertDiscountFieldsMatchType(
    discountType: string,
    dto: { percentOff?: string | null; amountOff?: string | null },
  ): void {
    const percentProvided =
      typeof dto.percentOff === 'string' && dto.percentOff.trim().length > 0;
    const amountProvided =
      typeof dto.amountOff === 'string' && dto.amountOff.trim().length > 0;

    if (percentProvided && discountType !== DISCOUNT_TYPE.PERCENTAGE) {
      throw new BadRequestException(PROMOTION_MESSAGES.PERCENTAGE_NOT_ALLOWED);
    }
    if (amountProvided && discountType !== DISCOUNT_TYPE.FIXED_AMOUNT) {
      throw new BadRequestException(
        PROMOTION_MESSAGES.FIXED_AMOUNT_NOT_ALLOWED,
      );
    }
  }

  /**
   * The complete rule set, applied to the resolved row rather than to one DTO.
   *
   * Incompatible fields that were explicitly supplied are rejected by
   * {@link assertDiscountFieldsMatchType} before the row is resolved. Anything
   * still present here is a value carried over from the old type, which the
   * resolvers have already cleared where necessary.
   */
  private assertShape(shape: PromotionShape): void {
    if (!PROMOTION_KINDS.includes(shape.kind as PromotionKind)) {
      throw new BadRequestException(PROMOTION_MESSAGES.KIND_INVALID);
    }
    if (!DISCOUNT_TYPES.includes(shape.discountType as DiscountType)) {
      throw new BadRequestException(PROMOTION_MESSAGES.DISCOUNT_TYPE_INVALID);
    }

    if (shape.kind === PROMOTION_KIND.COUPON && shape.code === null) {
      throw new BadRequestException(PROMOTION_MESSAGES.CODE_REQUIRED);
    }
    if (shape.kind === PROMOTION_KIND.AUTOMATIC && shape.code !== null) {
      throw new BadRequestException(PROMOTION_MESSAGES.CODE_NOT_ALLOWED);
    }
    if (shape.code !== null && shape.code.length > CODE_MAX_LENGTH) {
      throw new BadRequestException(PROMOTION_MESSAGES.CODE_TOO_LONG);
    }

    if (shape.name.length === 0) {
      throw new BadRequestException(PROMOTION_MESSAGES.NAME_REQUIRED);
    }
    if (shape.name.length > NAME_MAX_LENGTH) {
      throw new BadRequestException(PROMOTION_MESSAGES.NAME_TOO_LONG);
    }
    if (
      shape.description !== null &&
      shape.description.length > DESCRIPTION_MAX_LENGTH
    ) {
      throw new BadRequestException(PROMOTION_MESSAGES.DESCRIPTION_TOO_LONG);
    }

    switch (shape.discountType) {
      case DISCOUNT_TYPE.PERCENTAGE:
        if (
          shape.percentOff === null ||
          shape.percentOff.lte(0) ||
          shape.percentOff.gt(MAX_PERCENTAGE) ||
          shape.amountOff !== null
        ) {
          throw new BadRequestException(PROMOTION_MESSAGES.PERCENTAGE_REQUIRED);
        }
        break;

      case DISCOUNT_TYPE.FIXED_AMOUNT:
        if (shape.amountOff === null || shape.amountOff.lte(0)) {
          throw new BadRequestException(
            PROMOTION_MESSAGES.FIXED_AMOUNT_REQUIRED,
          );
        }
        if (shape.percentOff !== null) {
          throw new BadRequestException(
            PROMOTION_MESSAGES.PERCENTAGE_NOT_ALLOWED,
          );
        }
        break;

      case DISCOUNT_TYPE.FREE_SHIPPING:
        if (shape.percentOff !== null || shape.amountOff !== null) {
          throw new BadRequestException(
            PROMOTION_MESSAGES.FREE_SHIPPING_FIELDS_ABSENT,
          );
        }
        break;
    }

    if (shape.minSubtotal.isNegative()) {
      throw new BadRequestException(
        PROMOTION_MESSAGES.MIN_SUBTOTAL_NON_NEGATIVE,
      );
    }
    if (shape.maxDiscount !== null && shape.maxDiscount.lte(0)) {
      throw new BadRequestException(PROMOTION_MESSAGES.MAX_DISCOUNT_POSITIVE);
    }
    if (
      shape.usageLimitTotal !== null &&
      (!Number.isInteger(shape.usageLimitTotal) || shape.usageLimitTotal < 0)
    ) {
      throw new BadRequestException(
        PROMOTION_MESSAGES.USAGE_LIMIT_TOTAL_NON_NEGATIVE,
      );
    }
    if (
      shape.usageLimitPerUser !== null &&
      (!Number.isInteger(shape.usageLimitPerUser) ||
        shape.usageLimitPerUser < 0)
    ) {
      throw new BadRequestException(
        PROMOTION_MESSAGES.USAGE_LIMIT_PER_USER_NON_NEGATIVE,
      );
    }
    if (!Number.isInteger(shape.priority)) {
      throw new BadRequestException(PROMOTION_MESSAGES.PRIORITY_INTEGER);
    }
    if (
      shape.startsAt !== null &&
      shape.endsAt !== null &&
      shape.endsAt.getTime() <= shape.startsAt.getTime()
    ) {
      throw new BadRequestException(PROMOTION_MESSAGES.DATE_RANGE_INVALID);
    }
  }

  private toCreateData(shape: PromotionShape): CreatePromotionData {
    return {
      code: shape.code,
      name: shape.name,
      description: shape.description,
      kind: shape.kind,
      discountType: shape.discountType,
      percentOff:
        shape.percentOff === null ? null : shape.percentOff.toFixed(2),
      amountOff: shape.amountOff === null ? null : shape.amountOff.toFixed(2),
      minSubtotal: shape.minSubtotal.toFixed(2),
      maxDiscount:
        shape.maxDiscount === null ? null : shape.maxDiscount.toFixed(2),
      startsAt: shape.startsAt,
      endsAt: shape.endsAt,
      isActive: shape.isActive,
      usageLimitTotal: shape.usageLimitTotal,
      usageLimitPerUser: shape.usageLimitPerUser,
      priority: shape.priority,
    };
  }

  private async assertCodeAvailable(
    code: string,
    excludeId?: string,
  ): Promise<void> {
    const existing = await this.promotionsRepository.findByCode(code);
    if (existing !== null && existing.id !== excludeId) {
      throw new ConflictException(PROMOTION_MESSAGES.CODE_DUPLICATE);
    }
  }

  private assertPage(page: number, limit: number): void {
    if (!Number.isInteger(page) || page < 1) {
      throw new BadRequestException(PROMOTION_MESSAGES.PAGE_INVALID);
    }
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_PROMOTION_PAGE_SIZE
    ) {
      throw new BadRequestException(PROMOTION_MESSAGES.LIMIT_INVALID);
    }
  }

  private rethrowAsHttpError(error: unknown): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002' &&
      this.isPromotionCodeUniqueViolation(error)
    ) {
      throw new ConflictException(PROMOTION_MESSAGES.CODE_DUPLICATE);
    }
    throw error;
  }

  private isPromotionCodeUniqueViolation(
    error: Prisma.PrismaClientKnownRequestError,
  ): boolean {
    const target = error.meta?.['target'];
    if (Array.isArray(target)) return target.includes('code');
    if (typeof target === 'string') return target.includes('code');

    return error.meta?.['modelName'] === 'Promotion';
  }
}
