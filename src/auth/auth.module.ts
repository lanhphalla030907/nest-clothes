import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtAuthModule } from './jwt/jwt-auth.module.js';
import { PasswordModule } from './password/password.module.js';

/**
 * Owns authentication: the login endpoint, the current-user endpoint, and the identity
 * that flows out of both.
 *
 * The edges run one way — `AuthModule -> JwtAuthModule -> UsersModule -> PasswordModule`
 * — and nothing imports `AuthModule`. That matters because the user-owned features
 * (cart, wishlist, addresses, orders, checkout, payments) need `JwtAuthGuard` and
 * `RolesGuard` and must not pull in the login controller or `AuthService` to get them;
 * they import `JwtAuthModule` instead.
 *
 * Only `AuthService` and `AuthController` are declared here. `JwtAuthModule` is
 * imported, not re-exported: a feature module that needs a guard says so by importing
 * the module that owns it, so no consumer ends up with authentication capabilities it did
 * not ask for.
 */
@Module({
  imports: [PasswordModule, JwtAuthModule, UsersModule],
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}
