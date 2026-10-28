import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.js';
import { CheckoutService } from './checkout.service.js';
import { CheckoutResponseDto } from './dto/checkout-response.dto.js';
import { CheckoutDto } from './dto/checkout.dto.js';

/**
 * HTTP routing only: validate the request through the DTO and pipe, delegate to
 * `CheckoutService`, return its result. No business rule and no database access
 * lives here.
 *
 * ## Identity
 *
 * The caller is {@link CurrentUser}, resolved from a verified access token by
 * `JwtAuthGuard`. It replaced an `X-User-Id` header, which was a claim rather than
 * proof; a request without a valid `Authorization: Bearer` header is now a 401 and the
 * old header is ignored. The cart to be emptied and the order to be written belong to
 * the authenticated user, and nothing in the request can name a different one.
 *
 * ## Why the mount point carries no path
 *
 * `POST /checkout` is mounted on the root rather than under `/cart`, because the
 * *result* of a checkout is an order, not a cart: the cart is an input to it and is
 * gone afterwards. Nothing about the request names a cart id, which means a client
 * cannot ask to check out somebody else's cart — the cart is found by the authenticated
 * identity, and there is exactly one per user.
 *
 * ## The address is the only input
 *
 * `@Body() dto: CheckoutDto` under a global `ValidationPipe` running with
 * `forbidNonWhitelisted` means `{}`, a missing `addressId`, a malformed UUID and any
 * attempt to smuggle in a price, a total or a status are all 400s before the service
 * is reached. 404 is therefore free to mean only "that address is not yours, or does
 * not exist", and 409 to mean only "not enough stock".
 *
 * ## Status code
 *
 * `201 Created`, because a checkout creates a durable resource — the order — and the
 * response body carries its id and number. It is not `204`, and it is not `200`: the
 * client has something new to keep.
 */
@UseGuards(JwtAuthGuard)
@Controller('checkout')
export class CheckoutController {
  constructor(private readonly checkoutService: CheckoutService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  checkout(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CheckoutDto,
  ): Promise<CheckoutResponseDto> {
    return this.checkoutService.checkout(user.id, dto);
  }
}
