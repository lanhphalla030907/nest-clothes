import { Module } from '@nestjs/common';
import { CategoriesController } from './categories.controller.js';
import { CategoriesService } from './categories.service.js';
import { CategoriesRepository } from './repositories/categories.repository.js';

/**
 * Exports `CategoriesRepository` so that `ProductsService` can validate a
 * product's category through the repository boundary instead of querying
 * `categories` from its own repository. This mirrors `UsersModule`, which
 * exports `UsersRepository` for `AuthService`.
 *
 * `CategoriesService` is deliberately *not* exported: nothing outside this
 * module needs category business rules.
 *
 * `PrismaService` arrives without an explicit import because `PrismaModule` is
 * `@Global`. `AuthModule` is deliberately absent — categories have no
 * dependency on authentication.
 *
 * The graph stays acyclic: `ProductsModule` imports this module, never the
 * other way round.
 */
@Module({
  controllers: [CategoriesController],
  providers: [CategoriesService, CategoriesRepository],
  exports: [CategoriesRepository],
})
export class CategoriesModule {}