import { Module } from '@nestjs/common';
import { PasswordModule } from '../auth/password/password.module.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';
import { UsersRepository } from './repositories/users.repository.js';

/**
 * Owns the user aggregate and the registration endpoint.
 *
 * Imports `PasswordModule` only — deliberately **not** `AuthModule` and **not**
 * `JwtAuthModule`, and that is the edge worth noting. The guards live in
 * `JwtAuthModule`, which depends on `UsersRepository` from here to re-read the
 * authenticated user; importing it back would close a module cycle. The
 * administrative route that needs those guards therefore lives in `AdminModule`, which
 * sits above both.
 *
 * `UsersService` is exported as well as the repository, so the admin read reuses the same
 * safe DTO mapping rather than serialising a user row a second way.
 */
@Module({
  imports: [PasswordModule],
  controllers: [UsersController],
  providers: [UsersService, UsersRepository],
  exports: [UsersRepository, UsersService],
})
export class UsersModule {}
