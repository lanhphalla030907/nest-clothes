import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { TemporaryUserId } from '../common/decorators/temporary-user-id.decorator.js';
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
 * The caller is {@link TemporaryUserId}, the `X-User-Id` stand-in that exists
 * because authentication does not yet. It is a claim, not proof, which is why the
 * service verifies the user exists before it writes anything. The controller receives
 * the user id as an ordinary parameter and knows nothing about where it came from,
 * so replacing the decorator with a real guard is the only change needed later.
 *
 * ## Why the mount point carries no path
 *
 * `POST /checkout` is mounted on the root rather than under `/cart`, because the
 * *result* of a checkout is an order, not a cart: the cart is an input to it and is
 * gone afterwards. Nothing about the request names a cart id, which means a client
 * cannot ask to check out somebody else's cart — the cart is found by the claimed
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
@Controller('checkout')
export class CheckoutController {
  constructor(private readonly checkoutService: CheckoutService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  checkout(
    @TemporaryUserId(new ParseUUIDPipe()) userId: string,
    @Body() dto: CheckoutDto,
  ): Promise<CheckoutResponseDto> {
    return this.checkoutService.checkout(userId, dto);
  }
}
