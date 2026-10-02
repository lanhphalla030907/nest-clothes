import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { PasswordModule } from './password/password.module.js';

/**
 * Depends on `UsersModule` for `UsersRepository` and on `PasswordModule` for
 * Argon2id hashing. It is a leaf consumer: nothing imports `AuthModule`, which
 * is what keeps the graph acyclic.
 */
@Module({
  imports: [PasswordModule, UsersModule],
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}
