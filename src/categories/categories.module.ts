import { Module } from '@nestjs/common';
import { JwtAuthModule } from '../auth/jwt/jwt-auth.module.js';
import { CategoriesController } from './categories.controller.js';
import { CategoriesService } from './categories.service.js';
import { CategoriesRepository } from './repositories/categories.repository.js';

/**
 * Exports `CategoriesRepository` so that `ProductsService` can validate a
 * product's category through the repository boundary instead of querying
 * `categories` from its own repository. This mirrors `UsersModule`, which
 * exports `UsersRepository` for `AuthService`.
 *
 * Also exports `CategoriesService`, for `AdminCategoriesController`. The
 * administrative routes are a *different caller* of the category rules, not a
 * different set of rules: slug normalisation, the parent-is-active rule, the
 * circular-hierarchy check and the delete protection are reached by delegating
 * here rather than restated, so there is one implementation of each and the
 * admin surface cannot drift from the public one. Nothing else outside this
 * module imports it, and it grants no capability — the same methods that a
 * public route may call, plus none that it may not.
 *
 * `JwtAuthModule` is imported directly for `JwtAuthGuard` and `RolesGuard` on
 * the admin routes. It exports both guards plus `AccessTokenService` and
 * `UsersModule`, so the guards' dependencies resolve here without duplicating
 * any provider. `AuthModule` remains absent: no login capability is needed.
 *
 * `PrismaService` arrives without an explicit import because `PrismaModule` is
 * `@Global`.
 *
 * The graph stays acyclic: `ProductsModule` imports this module, never the
 * other way round; `JwtAuthModule` has no dependency on categories.
 */
@Module({
  imports: [JwtAuthModule],
  controllers: [CategoriesController],
  providers: [CategoriesService, CategoriesRepository],
  exports: [CategoriesRepository, CategoriesService],
})
export class CategoriesModule {}