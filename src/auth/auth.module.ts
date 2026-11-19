import { Module } from '@nestjs/common';
import { EmailModule } from '../email/email.module.js';
import { UsersModule } from '../users/users.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { GoogleAuthService } from './google/google-auth.service.js';
import { JwtAuthModule } from './jwt/jwt-auth.module.js';
import { PasswordModule } from './password/password.module.js';
import { PasswordResetTokenRepository } from './password-reset/password-reset-token.repository.js';
import { PasswordResetService } from './password-reset/password-reset.service.js';
import { AuthSessionService } from './refresh/auth-session.service.js';
import { RefreshSessionRepository } from './refresh/refresh-session.repository.js';
import { RefreshTokenService } from './refresh/refresh-token.service.js';
import { RefreshResultEncryptionService } from './refresh/refresh-result-encryption.service.js';
import { RefreshCleanupScheduler } from './refresh/refresh-cleanup.scheduler.js';
import { RefreshController } from './refresh/refresh.controller.js';

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
  imports: [PasswordModule, JwtAuthModule, UsersModule, EmailModule],
  controllers: [AuthController, RefreshController],
  providers: [
    AuthService,
    GoogleAuthService,
    PasswordResetService,
    PasswordResetTokenRepository,
    AuthSessionService,
    RefreshTokenService,
    RefreshResultEncryptionService,
    RefreshCleanupScheduler,
  ],
})
export class AuthModule {}
