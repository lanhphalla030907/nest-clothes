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
} from '@nestjs/common';
import { TemporaryUserId } from '../common/decorators/temporary-user-id.decorator.js';
import { AddWishlistItemDto } from './dto/add-wishlist-item.dto.js';
import { WishlistItemResponseDto } from './dto/wishlist-item-response.dto.js';
import { WishlistResponseDto } from './dto/wishlist-response.dto.js';
import { WishlistService } from './wishlist.service.js';

/**
 * HTTP routing only: parse the request through the pipes and DTOs, delegate to
 * `WishlistService`, return its result. No business rules and no database access
 * live here.
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
 * The caller is {@link TemporaryUserId}, the `X-User-Id` stand-in that exists
 * because authentication does not yet, shared with the cart feature. It is a claim,
 * not proof of identity. Controllers receive the user id as an ordinary parameter,
 * so swapping that decorator for a real guard is the only change this phase will
 * need. The controller mounts no guard of its own for the same reason.
 *
 * `:itemId` runs through `ParseUUIDPipe`, so a malformed id is a 400 before the
 * service is reached and 404 stays reserved for a well-formed id that is absent or
 * not the caller's.
 */
@Controller('wishlist')
export class WishlistController {
  constructor(private readonly wishlistService: WishlistService) {}

  @Get()
  findWishlist(
    @TemporaryUserId(new ParseUUIDPipe()) userId: string,
  ): Promise<WishlistResponseDto> {
    return this.wishlistService.findWishlist(userId);
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
    @TemporaryUserId(new ParseUUIDPipe()) userId: string,
    @Body() dto: AddWishlistItemDto,
  ): Promise<WishlistItemResponseDto> {
    return this.wishlistService.addItem(userId, dto);
  }

  @Delete('items/:itemId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeItem(
    @TemporaryUserId(new ParseUUIDPipe()) userId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ): Promise<void> {
    return this.wishlistService.removeItem(userId, itemId);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  clearWishlist(
    @TemporaryUserId(new ParseUUIDPipe()) userId: string,
  ): Promise<void> {
    return this.wishlistService.clearWishlist(userId);
  }
}
