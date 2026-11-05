import { Module } from '@nestjs/common';
import { PostersController } from './posters.controller.js';
import { PostersService } from './posters.service.js';
import { PostersRepository } from './repositories/posters.repository.js';

/**
 * Exports `PostersService` so `AdminPostersController` can reuse the same
 * poster rules instead of duplicating them.
 *
 * `PrismaService` and `CloudinaryService` are global, so this module does not
 * import them explicitly.
 */
@Module({
  controllers: [PostersController],
  providers: [PostersService, PostersRepository],
  exports: [PostersService],
})
export class PostersModule {}
