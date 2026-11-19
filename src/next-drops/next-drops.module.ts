import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { CollectionsModule } from '../collections/collections.module.js';
import { PromotionsModule } from '../promotions/promotions.module.js';
import { NextDropService } from './next-drops.service.js';
import { NextDropRepository } from './next-drops.repository.js';
import { NextDropPublicController } from './next-drops.public.controller.js';

/**
 * Scheduled "next drop" homepage feature.
 *
 * Reuses the existing promotion and collection records — a drop only references
 * them, it never creates another coupon or discount table.
 */
@Module({
  imports: [PrismaModule, CollectionsModule, PromotionsModule],
  providers: [NextDropService, NextDropRepository],
  controllers: [NextDropPublicController],
  exports: [NextDropService],
})
export class NextDropModule {}
