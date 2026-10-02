import { Module } from '@nestjs/common';
import { PasswordService } from './password.service.js';

/**
 * Owns the Argon2id password hashing capability.
 *
 * It is a standalone module rather than part of `AuthModule` so that both
 * `UsersModule` (registration) and `AuthModule` (login) can depend on
 * `PasswordService` without depending on each other. Folding it into
 * `AuthModule` would force a circular module import once `AuthModule` needs
 * `UsersRepository` from `UsersModule`.
 */
@Module({
  providers: [PasswordService],
  exports: [PasswordService],
})
export class PasswordModule {}
