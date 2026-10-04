import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { TemporaryUserId } from '../common/decorators/temporary-user-id.decorator.js';
import { AddCartItemDto } from './dto/add-cart-item.dto.js';
import { CartItemResponseDto } from './dto/cart-item-response.dto.js';
import { CartResponseDto } from './dto/cart-response.dto.js';
import { UpdateCartItemDto } from './dto/update-cart-item.dto.js';
import { CartService } from './cart.service.js';

/**
 * HTTP routing only: parse the request through the pipes and DTOs, delegate to
 * `CartService`, return its result. No business rules and no database access live
 * here.
 *
 * The controller is mounted under `/cart`, so every route acts on *the caller's*
 * cart. There is deliberately no cart id in any path: the cart is addressed by
 * its owner, which means a client can never name somebody else's cart. Lines are
 * addressed by `:itemId`, and the service confirms the line belongs to the
 * caller's cart before touching it — a line from another cart is a 404, not a
 * 403, so existence is not disclosed.
 *
 * ## Identity
 *
 * The caller is {@link TemporaryUserId}, the `X-User-Id` stand-in that exists
 * because authentication does not yet. It is a claim, not proof of identity.
 * Controllers receive the user id as an ordinary parameter, so swapping that
 * decorator for a real guard is the only change this phase will need. The
 * controller mounts no guard of its own for the same reason.
 *
 * `:itemId` runs through `ParseUUIDPipe`, so a malformed id is a 400 before the
 * service is reached and 404 stays reserved for a well-formed id that is absent
 * or not the caller's.
 */
@Controller('cart')
export class CartController {
  constructor(private readonly cartService: CartService) {}

  @Get()
  findCart(
    @TemporaryUserId(new ParseUUIDPipe()) userId: string,
  ): Promise<CartResponseDto> {
    return this.cartService.findCart(userId);
  }

  @Post('items')
  addItem(
    @TemporaryUserId(new ParseUUIDPipe()) userId: string,
    @Body() dto: AddCartItemDto,
  ): Promise<CartItemResponseDto> {
    return this.cartService.addItem(userId, dto);
  }

  @Patch('items/:itemId')
  updateItem(
    @TemporaryUserId(new ParseUUIDPipe()) userId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: UpdateCartItemDto,
  ): Promise<CartItemResponseDto> {
    return this.cartService.updateItem(userId, itemId, dto);
  }

  @Delete('items/:itemId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeItem(
    @TemporaryUserId(new ParseUUIDPipe()) userId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ): Promise<void> {
    return this.cartService.removeItem(userId, itemId);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  clearCart(
    @TemporaryUserId(new ParseUUIDPipe()) userId: string,
  ): Promise<void> {
    return this.cartService.clearCart(userId);
  }
}
