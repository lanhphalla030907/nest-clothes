import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { NextDropService } from './next-drops.service.js';
import { NextDropRepository } from './next-drops.repository.js';
import { CollectionsService } from '../collections/collections.service.js';
import { PromotionsRepository } from '../promotions/repositories/promotions.repository.js';

const DROP_A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DROP_B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const drop = (overrides: Record<string, unknown> = {}) => ({
  id: DROP_A_ID,
  title: 'Winter Archive',
  launchAt: new Date('2026-12-01T10:00:00.000Z'),
  collectionId: null,
  promotionId: null,
  buttonText: 'Get Access',
  buttonUrl: 'https://shop.example.com/winter-archive',
  isPublished: false,
  createdAt: new Date('2026-11-01T00:00:00.000Z'),
  updatedAt: new Date('2026-11-01T00:00:00.000Z'),
  ...overrides,
});

const buildTx = (publishedResult: unknown) => {
  const tx = {
    nextDrop: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: vi.fn().mockResolvedValue(publishedResult),
      update: vi.fn().mockResolvedValue(publishedResult),
      findUnique: vi.fn().mockResolvedValue(publishedResult),
    },
  };
  return tx;
};

describe('NextDropService single-publish rule', () => {
  let service: NextDropService;
  let prisma: PrismaService;
  let nextDropRepository: NextDropRepository;
  let collectionsService: CollectionsService;
  let promotionsRepository: PromotionsRepository;

  beforeEach(() => {
    prisma = {
      $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => {
        const tx = buildTx(drop({ id: DROP_B_ID, isPublished: true }));
        return callback(tx);
      }),
    } as unknown as PrismaService;

    nextDropRepository = {
      findById: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    } as unknown as NextDropRepository;

    collectionsService = { findOne: vi.fn() } as unknown as CollectionsService;
    promotionsRepository = { findById: vi.fn() } as unknown as PromotionsRepository;

    service = new NextDropService(
      prisma,
      nextDropRepository,
      collectionsService,
      promotionsRepository,
    );
  });

  it('unpublishes the currently published drop before publishing another', async () => {
    nextDropRepository.findById.mockResolvedValue(drop({ id: DROP_B_ID }));
    const tx = buildTx(drop({ id: DROP_B_ID, isPublished: true }));
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
      async (callback: (tx: unknown) => unknown) => callback(tx),
    );

    await service.publish(DROP_B_ID);

    expect(tx.nextDrop.updateMany).toHaveBeenCalledWith({
      where: { isPublished: true },
      data: { isPublished: false },
    });
    expect(tx.nextDrop.update).toHaveBeenCalledWith({
      where: { id: DROP_B_ID },
      data: { isPublished: true },
      include: { collection: true, promotion: true },
    });
  });

  it('throws when the drop to publish does not exist', async () => {
    nextDropRepository.findById.mockResolvedValue(null);
    await expect(service.publish(DROP_B_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
