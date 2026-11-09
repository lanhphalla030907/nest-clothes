import { Module } from '@nestjs/common';
import { PromotionEvaluatorService } from './promotion-evaluator.service.js';
import { PromotionsRepository } from './repositories/promotions.repository.js';
import { PromotionsService } from './promotions.service.js';

/**
 * Promotion rules and persistence.
 *
 * No controller is registered in this phase. The module exports the evaluator
 * and the domain service so checkout can import the evaluator when it is wired
 * in the next phase, and the future admin module can import the service without
 * depending on checkout.
 */
@Module({
  providers: [
    PromotionsService,
    PromotionEvaluatorService,
    PromotionsRepository,
  ],
  exports: [PromotionsService, PromotionEvaluatorService, PromotionsRepository],
})
export class PromotionsModule {}
