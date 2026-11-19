import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { Role } from '../generated/prisma/enums.js';
import { UserResponseDto } from '../users/dto/user-response.dto.js';
import { ChangeUserRoleDto } from '../users/dto/change-user-role.dto.js';
import { ChangeUserStatusDto } from '../users/dto/change-user-status.dto.js';
import { CreateUserDto } from '../users/dto/create-user.dto.js';
import { AdminUserListQueryDto } from '../users/dto/admin-user-list-query.dto.js';
import { AdminUserListResponseDto } from '../users/dto/admin-user-list-response.dto.js';
import { UsersService } from '../users/users.service.js';

/**
 * The administrative surface.
 *
 * The administrative user surface: read a user by id and create delivery staff.
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
   * `GET /admin/users` — the user list behind the admin role-management table.
   * Every row is a `UserResponseDto`, so no authentication material is returned.
   */
  @Get('users')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  findAllUsers(
    @Query() query: AdminUserListQueryDto,
  ): Promise<AdminUserListResponseDto> {
    return this.usersService.findPage(query);
  }

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

  @Post('users')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  createDeliveryStaff(
    @Body() dto: CreateUserDto,
  ): Promise<UserResponseDto> {
    return this.usersService.createDeliveryStaff(dto);
  }

  /**
   * `PATCH /admin/users/:id/role` — assign or change a role.
   *
   * The actor comes from `JwtAuthGuard` via `@CurrentUser`, never from the body or
   * the URL. `RolesGuard` has already established that the actor is an ADMIN; the
   * service additionally refuses self-changes and demotion of the last admin.
   */
  @Patch('users/:id/role')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  changeUserRole(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeUserRoleDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<UserResponseDto> {
    return this.usersService.changeRole(actor.id, id, dto.role);
  }

  /** Changes account access only; roles and related records are retained. */
  @Patch('users/:id/status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  changeUserStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeUserStatusDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<UserResponseDto> {
    return this.usersService.changeStatus(actor.id, id, dto.status);
  }
}
