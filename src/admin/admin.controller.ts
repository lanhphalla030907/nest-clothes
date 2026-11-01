import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { Role } from '../generated/prisma/enums.js';
import { UserResponseDto } from '../users/dto/user-response.dto.js';
import { CreateUserDto } from '../users/dto/create-user.dto.js';
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
}
