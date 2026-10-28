import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { UsersModule } from '../../users/users.module.js';
import { JwtAuthGuard } from '../guards/jwt-auth.guard.js';
import { RolesGuard } from '../guards/roles.guard.js';
import { AccessTokenService } from './access-token.service.js';
import { readJwtSettings, type JwtSettings } from './jwt.config.js';
import { JWT_SETTINGS } from './jwt.constants.js';

/**
 * Reads and validates the JWT settings, once, at module construction.
 *
 * A `useFactory` for the same reason the Cloudinary module uses one: the validated value
 * is built once and shared, so no consumer can observe a different environment from the
 * one the rest of the authentication flow sees. It throws at bootstrap when the signing
 * key is absent or too short, so a deployment without one fails before serving a
 * request rather than on the first login.
 */
const jwtSettingsProvider = {
  provide: JWT_SETTINGS,
  useFactory: (): JwtSettings => readJwtSettings(),
};

/**
 * Owns the JWT capability: the settings, the token service and the two guards.
 *
 * Deliberately *not* `@Global`. Every feature that protects a route imports it
 * explicitly, which keeps the dependency edge visible in that module's `imports` rather
 * than hidden in a global registration — and it is what lets a feature module reach
 * `JwtAuthGuard` without also inheriting `AuthModule`'s controller and login service.
 *
 * ## Why it imports `UsersModule`
 *
 * `JwtAuthGuard` re-reads the user row after verifying a token, so a suspended account,
 * a changed role or a deleted user takes effect on the next request instead of whenever
 * the token happens to expire. That single lookup is the reason this module depends on
 * `UsersRepository`.
 *
 * ## Why it also re-exports `UsersModule`
 *
 * A class-based guard is instantiated in the context of the module whose controller
 * carries it, not of the module that provides it. So a feature that mounts
 * `JwtAuthGuard` must be able to resolve *both* of the guard's dependencies —
 * `AccessTokenService` and `UsersRepository` — from its own imports. Re-exporting
 * `UsersModule` here makes that true by construction: importing `JwtAuthModule` is
 * sufficient, and no feature has to remember a second import purely to satisfy a guard.
 * `PaymentsModule`, which needs no user data of its own, is the case that proves it.
 *
 * ## The dependency direction
 *
 * `JwtAuthModule -> UsersModule -> PasswordModule`. Nothing here imports `AuthModule`,
 * and `AuthModule` imports this one for the login endpoint — so the graph stays acyclic:
 * a guard used by the cart or the checkout never drags the login controller along with
 * it.
 *
 * ## Why `JwtService` carries no secret
 *
 * Registered without one on purpose: `AccessTokenService` passes the secret explicitly
 * on every `sign` and every `verify`, so the key travels through exactly one file and a
 * `JwtService` obtained from anywhere else cannot be configured with a different one by
 * accident. A call that forgets to pass one fails closed rather than signing with a
 * default.
 */
@Module({
  imports: [UsersModule, JwtModule.register({})],
  providers: [jwtSettingsProvider, AccessTokenService, JwtAuthGuard, RolesGuard],
  exports: [AccessTokenService, JwtAuthGuard, RolesGuard, UsersModule],
})
export class JwtAuthModule {}
