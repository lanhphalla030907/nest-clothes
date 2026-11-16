import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Request body for registering or rebinding a push subscription.
 *
 * The `userId` is deliberately absent: ownership is derived exclusively from
 * the authenticated JWT, never from the request body.
 */
export class RegisterSubscriptionDto {
  @IsString()
  @MaxLength(2048)
  endpoint: string;

  @IsString()
  @MaxLength(500)
  p256dh: string;

  @IsString()
  @MaxLength(255)
  auth: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  userAgent?: string;
}

/**
 * Safe metadata returned to clients. The full endpoint and key material are
 * never exposed.
 */
export interface SubscriptionView {
  id: string;
  label?: string | null;
  userAgent?: string | null;
  isActive: boolean;
  createdAt: Date;
}

/**
 * Request body for revoking a subscription. Only the subscription id is
 * accepted; ownership is enforced by the authenticated user.
 */
export class RevokeSubscriptionDto {
  @IsString()
  id: string;
}

/**
 * Query parameters for listing subscriptions.
 */
export class ListSubscriptionsQueryDto {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
