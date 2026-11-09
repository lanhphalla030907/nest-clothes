import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type Promotion } from '../generated/prisma/client.js';
import {
  DISCOUNT_TYPE,
  PROMOTION_KIND,
} from './constants/promotion.constants.js';
import { CreatePromotionDto } from './dto/create-promotion.dto.js';
import { PromotionListQueryDto } from './dto/promotion-list-query.dto.js';
import { PromotionUsageListQueryDto } from './dto/promotion-usage-list-query.dto.js';
import { UpdatePromotionDto } from './dto/update-promotion.dto.js';
import { PromotionsService } from './promotions.service.js';
import { PromotionsRepository } from './repositories/promotions.repository.js';

const entity = (overrides: Partial<Promotion> = {}): Promotion => ({
  id: 'promotion-1',
  code: 'SAVE10',
  name: 'Save 10%',
  description: null,
  kind: PROMOTION_KIND.COUPON,
  discountType: DISCOUNT_TYPE.PERCENTAGE,
  percentOff: new Prisma.Decimal('10.00'),
  amountOff: null,
  minSubtotal: new Prisma.Decimal('0.00'),
  maxDiscount: null,
  startsAt: null,
  endsAt: null,
  isActive: true,
  usageLimitTotal: null,
  usageLimitPerUser: null,
  priority: 0,
  archivedAt: null,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  updatedAt: new Date('2026-10-01T00:00:00.000Z'),
  ...overrides,
});

const createDto = (
  overrides: Partial<CreatePromotionDto> = {},
): CreatePromotionDto =>
  Object.assign(new CreatePromotionDto(), {
    code: 'save10',
    name: 'Save 10%',
    kind: PROMOTION_KIND.COUPON,
    discountType: DISCOUNT_TYPE.PERCENTAGE,
    percentOff: '10.00',
    ...overrides,
  });

type RepositoryMock = {
  create: ReturnType<typeof vi.fn>;
  findById: ReturnType<typeof vi.fn>;
  findByCode: ReturnType<typeof vi.fn>;
  findPage: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  findUsagePage: ReturnType<typeof vi.fn>;
  countUsages: ReturnType<typeof vi.fn>;
  countUsagesForUser: ReturnType<typeof vi.fn>;
  findAutomaticCandidates: ReturnType<typeof vi.fn>;
};

describe('PromotionsService', () => {
  let repository: RepositoryMock;
  let service: PromotionsService;

  beforeEach(() => {
    repository = {
      create: vi.fn(),
      findById: vi.fn(),
      findByCode: vi.fn().mockResolvedValue(null),
      findPage: vi.fn(),
      update: vi.fn(),
      findUsagePage: vi.fn(),
      countUsages: vi.fn().mockResolvedValue(0),
      countUsagesForUser: vi.fn().mockResolvedValue(0),
      findAutomaticCandidates: vi.fn().mockResolvedValue([]),
    };
    service = new PromotionsService(
      repository as unknown as PromotionsRepository,
    );
  });

  describe('create', () => {
    it('normalises a coupon code and applies defaults', async () => {
      repository.create.mockResolvedValue(entity());

      const result = await service.create(
        createDto({ code: '  save10  ', description: '  Ten percent  ' }),
      );

      expect(repository.create).toHaveBeenCalledWith({
        code: 'SAVE10',
        name: 'Save 10%',
        description: 'Ten percent',
        kind: PROMOTION_KIND.COUPON,
        discountType: DISCOUNT_TYPE.PERCENTAGE,
        percentOff: '10.00',
        amountOff: null,
        minSubtotal: '0.00',
        maxDiscount: null,
        startsAt: null,
        endsAt: null,
        isActive: true,
        usageLimitTotal: null,
        usageLimitPerUser: null,
        priority: 0,
      });
      expect(result.code).toBe('SAVE10');
    });

    it('creates a free-shipping automatic promotion without a code', async () => {
      repository.create.mockResolvedValue(
        entity({
          kind: PROMOTION_KIND.AUTOMATIC,
          code: null,
          discountType: DISCOUNT_TYPE.FREE_SHIPPING,
          percentOff: null,
        }),
      );

      await service.create(
        createDto({
          kind: PROMOTION_KIND.AUTOMATIC,
          code: undefined,
          discountType: DISCOUNT_TYPE.FREE_SHIPPING,
          percentOff: undefined,
        }),
      );

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: PROMOTION_KIND.AUTOMATIC,
          code: null,
          discountType: DISCOUNT_TYPE.FREE_SHIPPING,
          percentOff: null,
          amountOff: null,
        }),
      );
    });

    it('requires a code for a coupon promotion', async () => {
      await expect(
        service.create(createDto({ code: undefined })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a code on an automatic promotion', async () => {
      await expect(
        service.create(
          createDto({
            kind: PROMOTION_KIND.AUTOMATIC,
            code: 'NOPE',
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('requires a percentage for a percentage promotion', async () => {
      await expect(
        service.create(createDto({ percentOff: undefined })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a percentage outside (0, 100]', async () => {
      await expect(
        service.create(createDto({ percentOff: '100.01' })),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.create(createDto({ percentOff: '0' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a fixed amount on a percentage promotion', async () => {
      await expect(
        service.create(createDto({ amountOff: '5.00' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('requires a positive fixed amount', async () => {
      await expect(
        service.create(
          createDto({
            discountType: DISCOUNT_TYPE.FIXED_AMOUNT,
            percentOff: undefined,
            amountOff: '0.00',
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects discount fields on a free-shipping promotion', async () => {
      await expect(
        service.create(
          createDto({
            discountType: DISCOUNT_TYPE.FREE_SHIPPING,
            percentOff: '10.00',
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a negative minimum subtotal', async () => {
      await expect(
        service.create(createDto({ minSubtotal: '-1.00' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a non-positive maximum discount', async () => {
      await expect(
        service.create(createDto({ maxDiscount: '0.00' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a negative or fractional usage limit', async () => {
      await expect(
        service.create(createDto({ usageLimitTotal: -1 })),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.create(createDto({ usageLimitPerUser: 1.5 })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an invalid date range', async () => {
      await expect(
        service.create(
          createDto({
            startsAt: '2026-11-06T12:00:00.000Z',
            endsAt: '2026-11-06T12:00:00.000Z',
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an invalid timestamp', async () => {
      await expect(
        service.create(createDto({ startsAt: 'not-a-date' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a duplicate coupon code', async () => {
      repository.findByCode.mockResolvedValue(entity({ id: 'other' }));

      await expect(service.create(createDto())).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('maps a database unique violation to a conflict', async () => {
      repository.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '7.10.0',
          meta: { target: ['code'] },
        }),
      );

      await expect(service.create(createDto())).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('update', () => {
    it('merges a type change and clears the old discount field', async () => {
      repository.findById.mockResolvedValue(entity());
      repository.update.mockResolvedValue(
        entity({
          discountType: DISCOUNT_TYPE.FIXED_AMOUNT,
          percentOff: null,
          amountOff: new Prisma.Decimal('5.00'),
        }),
      );

      await service.update(
        'promotion-1',
        Object.assign(new UpdatePromotionDto(), {
          discountType: DISCOUNT_TYPE.FIXED_AMOUNT,
          amountOff: '5.00',
        }),
      );

      expect(repository.update).toHaveBeenCalledWith(
        'promotion-1',
        expect.objectContaining({
          discountType: DISCOUNT_TYPE.FIXED_AMOUNT,
          percentOff: null,
          amountOff: '5.00',
        }),
      );
    });

    it('requires the new type field when changing type', async () => {
      repository.findById.mockResolvedValue(entity());

      await expect(
        service.update(
          'promotion-1',
          Object.assign(new UpdatePromotionDto(), {
            discountType: DISCOUNT_TYPE.FIXED_AMOUNT,
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('clears the code when switching to an automatic promotion', async () => {
      repository.findById.mockResolvedValue(entity());
      repository.update.mockResolvedValue(
        entity({
          kind: PROMOTION_KIND.AUTOMATIC,
          code: null,
        }),
      );

      await service.update(
        'promotion-1',
        Object.assign(new UpdatePromotionDto(), {
          kind: PROMOTION_KIND.AUTOMATIC,
        }),
      );

      expect(repository.update).toHaveBeenCalledWith(
        'promotion-1',
        expect.objectContaining({
          kind: PROMOTION_KIND.AUTOMATIC,
          code: null,
        }),
      );
    });

    it('rejects a missing promotion', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(
        service.update('missing', new UpdatePromotionDto()),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('state changes', () => {
    it('activates a paused promotion', async () => {
      repository.findById.mockResolvedValue(entity({ isActive: false }));
      repository.update.mockResolvedValue(entity({ isActive: true }));

      const result = await service.activate('promotion-1');

      expect(repository.update).toHaveBeenCalledWith('promotion-1', {
        isActive: true,
      });
      expect(result.isActive).toBe(true);
    });

    it('does not activate an archived promotion', async () => {
      repository.findById.mockResolvedValue(
        entity({ isActive: false, archivedAt: new Date() }),
      );

      await expect(service.activate('promotion-1')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('returns a paused promotion without a write', async () => {
      repository.findById.mockResolvedValue(entity({ isActive: false }));

      const result = await service.pause('promotion-1');

      expect(result.isActive).toBe(false);
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('archives a promotion by setting archivedAt and pausing it', async () => {
      repository.findById.mockResolvedValue(entity());
      repository.update.mockResolvedValue(
        entity({ isActive: false, archivedAt: new Date() }),
      );

      const result = await service.archive('promotion-1');

      expect(repository.update).toHaveBeenCalledWith(
        'promotion-1',
        expect.objectContaining({
          isActive: false,
          archivedAt: expect.any(Date),
        }),
      );
      expect(result.archivedAt).not.toBeNull();
    });

    it('does not move an existing archive timestamp', async () => {
      const archivedAt = new Date('2026-10-02T00:00:00.000Z');
      repository.findById.mockResolvedValue(
        entity({ isActive: false, archivedAt }),
      );

      const result = await service.archive('promotion-1');

      expect(repository.update).not.toHaveBeenCalled();
      expect(result.archivedAt).toBe(archivedAt);
    });
  });

  describe('listings', () => {
    it('returns a page with totalPages', async () => {
      repository.findPage.mockResolvedValue({ items: [entity()], total: 21 });

      const result = await service.list(
        Object.assign(new PromotionListQueryDto(), { page: 2, limit: 10 }),
      );

      expect(repository.findPage).toHaveBeenCalledWith({
        page: 2,
        limit: 10,
        kind: undefined,
        discountType: undefined,
        isActive: undefined,
        archived: undefined,
        search: undefined,
      });
      expect(result.items).toHaveLength(1);
      expect(result.pagination).toEqual({
        page: 2,
        limit: 10,
        total: 21,
        totalPages: 3,
      });
    });

    it('normalises the search and forwards filters', async () => {
      repository.findPage.mockResolvedValue({ items: [], total: 0 });

      await service.list(
        Object.assign(new PromotionListQueryDto(), {
          isActive: true,
          archived: false,
          kind: PROMOTION_KIND.COUPON,
          search: '  save  ',
        }),
      );

      expect(repository.findPage).toHaveBeenCalledWith(
        expect.objectContaining({
          isActive: true,
          archived: false,
          kind: PROMOTION_KIND.COUPON,
          search: 'save',
        }),
      );
    });

    it('rejects an invalid kind filter', async () => {
      await expect(
        service.list(
          Object.assign(new PromotionListQueryDto(), { kind: 'OTHER' }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects invalid pagination', async () => {
      await expect(
        service.list(Object.assign(new PromotionListQueryDto(), { page: 0 })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('returns paginated usage history', async () => {
      repository.findById.mockResolvedValue(entity());
      repository.findUsagePage.mockResolvedValue({
        items: [
          {
            id: 'usage-1',
            promotionId: 'promotion-1',
            orderId: 'order-1',
            userId: 'user-1',
            codeSnapshot: 'SAVE10',
            nameSnapshot: 'Save 10%',
            discountType: DISCOUNT_TYPE.PERCENTAGE,
            percentOff: new Prisma.Decimal('10.00'),
            amountOff: null,
            discountAmount: new Prisma.Decimal('5.00'),
            subtotalAtUse: new Prisma.Decimal('50.00'),
            createdAt: new Date('2026-11-06T00:00:00.000Z'),
            user: {
              id: 'user-1',
              firstName: 'Ada',
              lastName: 'Lovelace',
              email: 'ada@example.com',
            },
            order: {
              id: 'order-1',
              orderNumber: 'ORD-1',
            },
          },
        ],
        total: 1,
      });

      const result = await service.listUsages(
        'promotion-1',
        Object.assign(new PromotionUsageListQueryDto(), {
          page: 1,
          limit: 20,
        }),
      );

      expect(result.items[0].orderNumber).toBe('ORD-1');
      expect(result.items[0].discountAmount).toBe('5.00');
      expect(result.items[0].user.email).toBe('ada@example.com');
      expect(result.pagination.totalPages).toBe(1);
    });

    it('requires the promotion to exist before listing usages', async () => {
      repository.findById.mockResolvedValue(null);

      await expect(
        service.listUsages('missing', new PromotionUsageListQueryDto()),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
