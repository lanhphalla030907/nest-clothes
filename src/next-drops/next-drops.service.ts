import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { NextDropRepository } from './next-drops.repository.js';
import { nextDropResponse, type NextDropResponseDto } from './next-drops.dto.js';
import { CollectionsService } from '../collections/collections.service.js';
import { PromotionsRepository } from '../promotions/repositories/promotions.repository.js';

@Injectable()
export class NextDropService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly nextDropRepository: NextDropRepository,
    private readonly collectionsService: CollectionsService,
    private readonly promotionsRepository: PromotionsRepository,
  ) {}

  async create(data: {
    title: string;
    launchAt: string | Date;
    collectionId?: string | null | undefined;
    promotionId?: string | null | undefined;
    buttonText?: string | null | undefined;
    buttonUrl: string;
    isPublished?: boolean;
  }): Promise<NextDropResponseDto> {
    await this.assertCollectionExists(data.collectionId);
    await this.assertPromotionExists(data.promotionId);

    const launchAt = this.parseLaunchAt(data.launchAt);

    const dropData: Prisma.NextDropUncheckedCreateInput = {
      title: data.title.trim(),
      launchAt,
      collectionId: data.collectionId ?? null,
      promotionId: data.promotionId ?? null,
      buttonText: data.buttonText ?? null,
      buttonUrl: data.buttonUrl,
      isPublished: data.isPublished === true,
    };

    if (data.isPublished === true) {
      return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.nextDrop.updateMany({ where: { isPublished: true }, data: { isPublished: false } });
        const created = await tx.nextDrop.create({
          data: dropData,
          include: { collection: true, promotion: true },
        });
        return nextDropResponse(created);
      });
    }

    const created = await this.nextDropRepository.create(dropData);
    return nextDropResponse(created);
  }

  async findPublished(): Promise<NextDropResponseDto | null> {
    const published = await this.nextDropRepository.findPublished();
    if (published === null) return null;
    return nextDropResponse(published);
  }

  async findAll(): Promise<NextDropResponseDto[]> {
    const drops = await this.nextDropRepository.findAll();
    return drops.map((drop) => nextDropResponse(drop));
  }

  async findById(id: string): Promise<NextDropResponseDto> {
    const drop = await this.nextDropRepository.findById(id);
    if (drop === null) throw new NotFoundException(`Next drop ${id} does not exist`);
    return nextDropResponse(drop);
  }

  async update(
    id: string,
    data: {
      title?: string;
      launchAt?: string | Date | undefined;
      collectionId?: string | null | undefined;
      promotionId?: string | null | undefined;
      buttonText?: string | null | undefined;
      buttonUrl?: string;
      isPublished?: boolean;
    },
  ): Promise<NextDropResponseDto> {
    const existing = await this.nextDropRepository.findById(id);
    if (existing === null) throw new NotFoundException(`Next drop ${id} does not exist`);

    await this.assertCollectionExists(data.collectionId);
    await this.assertPromotionExists(data.promotionId);

    const updateData: Prisma.NextDropUncheckedUpdateInput = {};
    if (data.title !== undefined) updateData.title = data.title.trim();
    if (data.launchAt !== undefined) updateData.launchAt = this.parseLaunchAt(data.launchAt);
    if (data.collectionId !== undefined) updateData.collectionId = data.collectionId ?? null;
    if (data.promotionId !== undefined) updateData.promotionId = data.promotionId ?? null;
    if (data.buttonText !== undefined) updateData.buttonText = data.buttonText ?? null;
    if (data.buttonUrl !== undefined) updateData.buttonUrl = data.buttonUrl;

    if (data.isPublished === true) {
      return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.nextDrop.updateMany({ where: { isPublished: true }, data: { isPublished: false } });
        const updated = await tx.nextDrop.update({
          where: { id },
          data: { ...updateData, isPublished: true },
          include: { collection: true, promotion: true },
        });
        return nextDropResponse(updated);
      });
    }

    if (data.isPublished === false) {
      return nextDropResponse(
        await this.nextDropRepository.update(id, { ...updateData, isPublished: false }),
      );
    }

    return nextDropResponse(await this.nextDropRepository.update(id, updateData));
  }

  async publish(id: string): Promise<NextDropResponseDto> {
    const existing = await this.nextDropRepository.findById(id);
    if (existing === null) throw new NotFoundException(`Next drop ${id} does not exist`);

    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.nextDrop.updateMany({ where: { isPublished: true }, data: { isPublished: false } });
      const updated = await tx.nextDrop.update({
        where: { id },
        data: { isPublished: true },
        include: { collection: true, promotion: true },
      });
      return nextDropResponse(updated);
    });
  }

  async unpublish(id: string): Promise<NextDropResponseDto> {
    const drop = await this.nextDropRepository.findById(id);
    if (drop === null) throw new NotFoundException(`Next drop ${id} does not exist`);
    return nextDropResponse(
      await this.nextDropRepository.update(id, { isPublished: false }),
    );
  }

  async remove(id: string): Promise<void> {
    const drop = await this.nextDropRepository.findById(id);
    if (drop === null) throw new NotFoundException(`Next drop ${id} does not exist`);
    await this.nextDropRepository.remove(id);
  }

  private parseLaunchAt(value: string | Date): Date {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new BadRequestException('Launch date is invalid.');
    return date;
  }

  private async assertCollectionExists(collectionId: string | null | undefined): Promise<void> {
    if (collectionId === null || collectionId === undefined) return;
    await this.collectionsService.findOne(collectionId);
  }

  private async assertPromotionExists(promotionId: string | null | undefined): Promise<void> {
    if (promotionId === null || promotionId === undefined) return;
    const promotion = await this.promotionsRepository.findById(promotionId);
    if (promotion === null) {
      throw new NotFoundException(`Promotion ${promotionId} does not exist`);
    }
  }
}
