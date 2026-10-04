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
import { AddressResponseDto } from './dto/address-response.dto.js';
import { CreateAddressDto } from './dto/create-address.dto.js';
import { UpdateAddressDto } from './dto/update-address.dto.js';
import { AddressesService } from './addresses.service.js';

/**
 * HTTP routing only: parse the request through the pipes and DTOs, delegate to
 * `AddressesService`, return its result. No business rules and no database access
 * live here.
 *
 * The controller is mounted under `/addresses` and every route is scoped by the
 * caller's identity, so a client never names an owner: it can only ever reach its own
 * address book. `:id` addresses one entry within it, and the service confirms
 * ownership before touching it — an id belonging to another user is a 404, not a
 * 403, so existence is not disclosed.
 *
 * ## Identity
 *
 * The caller is {@link TemporaryUserId}, the `X-User-Id` stand-in that exists
 * because authentication does not yet, shared with the cart and wishlist features.
 * It is a claim, not proof of identity. Controllers receive the user id as an
 * ordinary parameter, so swapping that decorator for a real guard is the only change
 * a later phase will need. The controller mounts no guard of its own for the same
 * reason.
 *
 * `:id` runs through `ParseUUIDPipe`, so a malformed id is a 400 before the service
 * is reached and 404 stays reserved for a well-formed id that is absent or not the
 * caller's.
 *
 * ## Why there is a dedicated `POST /addresses/:id/default`
 *
 * "Make this my default" is a distinct intent from "edit this address", and it is
 * the only write in this feature that moves the single default slot. Giving it its
 * own route means a client never has to send `PATCH {"isDefault": true}` to mean it,
 * and it keeps the one invariant-carrying operation obvious in the API surface.
 */
@Controller('addresses')
export class AddressesController {
  constructor(private readonly addressesService: AddressesService) {}

  /**
   * The caller's address book, default first.
   *
   * Answers `200` with an empty list for a user who has saved none: an empty
   * address book is a normal state, not a missing resource.
   */
  @Get()
  findAll(
    @TemporaryUserId(new ParseUUIDPipe()) userId: string,
  ): Promise<AddressResponseDto[]> {
    return this.addressesService.findAll(userId);
  }

  @Get(':id')
  findOne(
    @TemporaryUserId(new ParseUUIDPipe()) userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AddressResponseDto> {
    return this.addressesService.findOne(userId, id);
  }

  @Post()
  create(
    @TemporaryUserId(new ParseUUIDPipe()) userId: string,
    @Body() dto: CreateAddressDto,
  ): Promise<AddressResponseDto> {
    return this.addressesService.create(userId, dto);
  }

  /**
   * Applies a partial update.
   *
   * `200` rather than `204` because the whole address comes back: a client that
   * promoted an address to default needs the new `isDefault`, and echoing the
   * authoritative row avoids a second request to confirm what just happened.
   */
  @Patch(':id')
  update(
    @TemporaryUserId(new ParseUUIDPipe()) userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAddressDto,
  ): Promise<AddressResponseDto> {
    return this.addressesService.update(userId, id, dto);
  }

  /**
   * Makes one address the default.
   *
   * A `POST` because it is a state transition with a side effect — it demotes
   * whichever address held the default — not an edit of the addressed resource. It
   * answers `200` with the promoted address, and is idempotent: naming the current
   * default succeeds without changing anything.
   */
  /**
   * Answers 200, not the 201 a bare `POST` implies: nothing is created here, an
   * existing address is promoted and the previous default demoted.
   */
  @Post(':id/default')
  @HttpCode(HttpStatus.OK)
  setDefault(
    @TemporaryUserId(new ParseUUIDPipe()) userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AddressResponseDto> {
    return this.addressesService.setDefault(userId, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @TemporaryUserId(new ParseUUIDPipe()) userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.addressesService.remove(userId, id);
  }
}
