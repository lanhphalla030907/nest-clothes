import { Body, Controller, Post } from '@nestjs/common';
import { CreateUserDto } from './dto/create-user.dto.js';
import { UserResponseDto } from './dto/user-response.dto.js';
import { UsersService } from './users.service.js';

/**
 * Registration only.
 *
 * `POST /users` is deliberately unauthenticated — a customer has to be able to create an
 * account before they can hold a token — and it always creates a `CUSTOMER`.
 * Nothing here lets a caller state a role: `CreateUserDto` has no such field, so under
 * the global `forbidNonWhitelisted` pipe an attempt to send one is a 400 rather than a
 * silently ignored value.
 *
 * Reading a user *other than the caller* lives in `AdminModule`, which is the only
 * module that mounts `@Roles(Role.ADMIN)`. Keeping it out of here is what stops this
 * module from needing the guards, and therefore from needing `JwtAuthModule` — an edge
 * that would close a cycle, since the guards depend on `UsersRepository`.
 */
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  create(@Body() dto: CreateUserDto): Promise<UserResponseDto> {
    return this.usersService.create(dto);
  }
}
