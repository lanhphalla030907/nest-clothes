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
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.js';
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
 * The caller is {@link CurrentUser}, resolved from a verified access token by
 * `JwtAuthGuard`. It replaced an `X-User-Id` header, which was a *claim* — any caller
 * who knew a UUID could send it — and there is no fallback to it: a request without a
 * valid `Authorization: Bearer` header is a 401 before this controller runs, even if it
 * still carries that header. Ownership therefore comes from `req.user`, which nothing in
 * the request can influence.
 *
 * No `ParseUUIDPipe` is applied to the identity: the guard resolved it from a database
 * row, so a malformed identity was already a 401. `:itemId` still runs through it, so a
 * malformed id is a 400 before the service is reached and 404 stays reserved for a
 * well-formed id that is absent or not the caller's.
 */
@UseGuards(JwtAuthGuard)
@Controller('cart')
export class CartController {
  constructor(private readonly cartService: CartService) {}

  @Get()
  findCart(@CurrentUser() user: AuthenticatedUser): Promise<CartResponseDto> {
    return this.cartService.findCart(user.id);
  }

  @Post('items')
  addItem(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AddCartItemDto,
  ): Promise<CartItemResponseDto> {
    return this.cartService.addItem(user.id, dto);
  }

  @Patch('items/:itemId')
  updateItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: UpdateCartItemDto,
  ): Promise<CartItemResponseDto> {
    return this.cartService.updateItem(user.id, itemId, dto);
  }

  @Delete('items/:itemId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ): Promise<void> {
    return this.cartService.removeItem(user.id, itemId);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  clearCart(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    return this.cartService.clearCart(user.id);
  }
}
