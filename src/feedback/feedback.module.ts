import { Module } from '@nestjs/common';
import { JwtAuthModule } from '../auth/jwt/jwt-auth.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AdminFeedbackController } from './admin-feedback.controller.js';
import { FeedbackController } from './feedback.controller.js';
import { FeedbackRepository } from './feedback.repository.js';
import { FeedbackService } from './feedback.service.js';
import { PublicFeedbackController } from './public-feedback.controller.js';

/**
 * Customer feedback about the store and its services.
 *
 * Feedback is general: no product, no order, no star rating, no reply, and no
 * approval workflow beyond publishing and unpublishing.
 *
 * The module owns three route surfaces:
 *
 * - `FeedbackController` — the signed-in customer's own feedback, guarded by
 *   `JwtAuthGuard`. The customer id is derived from the session, never the
 *   request.
 * - `AdminFeedbackController` — every feedback row, guarded by `JwtAuthGuard`
 *   and `RolesGuard` with `Role.ADMIN`.
 * - `PublicFeedbackController` — published feedback only, open to everyone.
 *
 * It imports `JwtAuthModule`, which re-exports `UsersRepository`, so the service
 * can confirm an admin's chosen customer is a real `CUSTOMER` account without a
 * second import.
 */
@Module({
  imports: [PrismaModule, JwtAuthModule],
  controllers: [PublicFeedbackController, AdminFeedbackController, FeedbackController],
  providers: [FeedbackRepository, FeedbackService],
  exports: [FeedbackService],
})
export class FeedbackModule {}
