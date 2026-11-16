import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import {
  AuthRateLimiterGuard,
} from '../auth/guards/auth-rate-limiter.guard.js';
import {
  AuthRateLimit,
} from '../auth/guards/auth-rate-limit.decorator.js';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.js';
import { PushSubscriptionService } from './push-subscription.service.js';
import { RegisterSubscriptionDto } from './push-subscription.dto.js';
import { ListSubscriptionsQueryDto } from './push-subscription.dto.js';
import type { SubscriptionView } from './push-subscription.dto.js';

/**
 * Authenticated push subscription management APIs.
 *
 * All routes require a valid JWT. The caller's identity comes exclusively from
 * `req.user`, which `JwtAuthGuard` populates from a database row — request
 * bodies and headers can never assert a different user.
 *
 * Responses return only safe metadata: the full `endpoint`, `p256dh`, and
 * `auth` values are stored server-side and never exposed.
 */
@UseGuards(JwtAuthGuard)
@Controller('push/subscriptions')
export class PushSubscriptionController {
  constructor(private readonly service: PushSubscriptionService) {}

  /**
   * `POST /push/subscriptions` — register or rebind a push subscription.
   *
   * Rate-limited per client IP to prevent storage abuse. The subscription is
   * bound to the authenticated user only; an endpoint already owned by another
   * user is transferred in a single transaction.
   */
  @Post()
  @UseGuards(AuthRateLimiterGuard)
  @AuthRateLimit({ limit: 10, windowMs: 60_000 })
  async register(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RegisterSubscriptionDto,
  ): Promise<SubscriptionView> {
    const row = await this.service.registerSubscription(
      dto.endpoint,
      dto.p256dh,
      dto.auth,
      dto.userAgent ?? null,
      user.id,
    );

    if (row === null) {
      throw new InternalServerErrorException('Failed to register push subscription');
    }

    return {
      id: row.id,
      label: row.userAgent ?? null,
      userAgent: row.userAgent ?? null,
      isActive: row.isActive,
      createdAt: row.createdAt,
    };
  }

  /**
   * `GET /push/subscriptions` — list the caller's subscriptions.
   *
   * Returns safe metadata only, scoped to the authenticated user.
   */
  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() _query: ListSubscriptionsQueryDto,
  ): Promise<SubscriptionView[]> {
    return this.service.listSubscriptions(user.id);
  }

  /**
   * `DELETE /push/subscriptions/:id` — revoke (soft-delete) a subscription.
   *
   * Rate-limited per client IP. Ownership is enforced by the authenticated
   * user; revoking another user's subscription is a 404.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(AuthRateLimiterGuard)
  @AuthRateLimit({ limit: 10, windowMs: 60_000 })
  async revoke(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.service.revokeSubscription(id, user.id);
  }
}
