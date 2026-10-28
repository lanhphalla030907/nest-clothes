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
import { AddressResponseDto } from './dto/address-response.dto.js';
import { CreateAddressDto } from './dto/create-address.dto.js';
import { UpdateAddressDto } from './dto/update-address.dto.js';
import { AddressesService } from './addresses.service.js';

/**
 * HTTP routing only: parse the request through the pipes and DTOs, delegate to
 * `AddressesService`, return its result. No business rules and no database access
 * lives here.
 *
 * The controller is mounted under `/addresses` and every route is scoped by the
 * caller's identity, so a client never names an owner: it can only ever reach its own
 * address book. `:id` addresses one entry within it, and the service confirms
 * ownership before touching it — an id belonging to another user is a 404, not a
 * 403, so existence is not disclosed.
 *
 * ## Identity
 *
 * The caller is {@link CurrentUser}, resolved from a verified access token by
 * `JwtAuthGuard`, replacing the `X-User-Id` claim this controller used to accept. A
 * request without a valid `Authorization: Bearer` header is a 401 and the old header is
 * ignored, so there is no way to select whose address book is addressed.
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
@UseGuards(JwtAuthGuard)
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
  findAll(@CurrentUser() user: AuthenticatedUser): Promise<AddressResponseDto[]> {
    return this.addressesService.findAll(user.id);
  }

  @Get(':id')
  findOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AddressResponseDto> {
    return this.addressesService.findOne(user.id, id);
  }

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateAddressDto,
  ): Promise<AddressResponseDto> {
    return this.addressesService.create(user.id, dto);
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
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAddressDto,
  ): Promise<AddressResponseDto> {
    return this.addressesService.update(user.id, id, dto);
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
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AddressResponseDto> {
    return this.addressesService.setDefault(user.id, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.addressesService.remove(user.id, id);
  }
}
