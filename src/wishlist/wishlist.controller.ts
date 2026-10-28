import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.js';
import { AddWishlistItemDto } from './dto/add-wishlist-item.dto.js';
import { WishlistItemResponseDto } from './dto/wishlist-item-response.dto.js';
import { WishlistResponseDto } from './dto/wishlist-response.dto.js';
import { WishlistService } from './wishlist.service.js';

/**
 * HTTP routing only: parse the request through the pipes and DTOs, delegate to
 * `WishlistService`, return its result. No business rules and no database access
 * lives here.
 *
 * The controller is mounted under `/wishlist`, so every route acts on *the caller's*
 * wishlist. There is deliberately no wishlist id in any path: the wishlist is
 * addressed by its owner, which means a client can never name somebody else's list.
 * Entries are addressed by `:itemId`, and the service confirms the entry belongs to
 * the caller's wishlist before touching it — an entry from another wishlist is a
 * 404, not a 403, so existence is not disclosed.
 *
 * ## Identity
 *
 * The caller is {@link CurrentUser}, resolved from a verified access token by
 * `JwtAuthGuard`. It replaced an `X-User-Id` header, which was a claim rather than
 * proof; a request without a valid `Authorization: Bearer` header is now a 401, and the
 * old header is ignored even when present. Ownership comes from `req.user` alone.
 *
 * `:itemId` runs through `ParseUUIDPipe`, so a malformed id is a 400 before the
 * service is reached and 404 stays reserved for a well-formed id that is absent or not
 * the caller's.
 */
@UseGuards(JwtAuthGuard)
@Controller('wishlist')
export class WishlistController {
  constructor(private readonly wishlistService: WishlistService) {}

  @Get()
  findWishlist(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WishlistResponseDto> {
    return this.wishlistService.findWishlist(user.id);
  }

  /**
   * Saves a product on the caller's wishlist.
   *
   * Answers `201` whether the entry was just created or already existed, because
   * from the caller's point of view the product is saved either way; see
   * `WishlistService.addItem` for why a duplicate is a no-op rather than a 409.
   */
  @Post('items')
  addItem(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AddWishlistItemDto,
  ): Promise<WishlistItemResponseDto> {
    return this.wishlistService.addItem(user.id, dto);
  }

  @Delete('items/:itemId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeItem(
    @CurrentUser() user: AuthenticatedUser,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ): Promise<void> {
    return this.wishlistService.removeItem(user.id, itemId);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  clearWishlist(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    return this.wishlistService.clearWishlist(user.id);
  }
}
