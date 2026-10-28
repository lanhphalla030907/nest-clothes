import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { Role } from '../generated/prisma/enums.js';
import { UserResponseDto } from '../users/dto/user-response.dto.js';
import { UsersService } from '../users/users.service.js';

/**
 * The administrative surface.
 *
 * One route, and it exists to make role authorisation observable end to end: without an
 * endpoint that only an `ADMIN` may reach, `@Roles(Role.ADMIN)` and `RolesGuard` would be
 * code nothing exercised, and "it rejects a customer" would be an untested claim.
 *
 * It reads a user **other than the caller**, which is the one place in this application
 * where that is legitimate — and it is legitimate precisely because the caller's role is
 * checked first. Every other route derives its subject from the authenticated identity
 * and never from the request.
 *
 * The guard order is load-bearing: `JwtAuthGuard` establishes who the caller is, and
 * `RolesGuard` then asks whether that identity is allowed here. Swapping them turns
 * every authenticated request into a 401.
 */
@Controller('admin')
export class AdminController {
  constructor(private readonly usersService: UsersService) {}

  /**
   * `GET /admin/users/:id` — read any user.
   *
   * `401` without a valid token, `403` for an authenticated `CUSTOMER`, `200` for an
   * `ADMIN`, `404` for an id that does not exist. The 403 body names no role, so a
   * rejected caller learns nothing beyond the fact that it was refused.
   */
  @Get('users/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  findUser(@Param('id', ParseUUIDPipe) id: string): Promise<UserResponseDto> {
    return this.usersService.findOne(id);
  }
}
