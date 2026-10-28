import { Module } from '@nestjs/common';
import { ProductsModule } from '../products/products.module.js';
import { ProductImagesController } from './product-images.controller.js';
import { ProductImagesService } from './product-images.service.js';
import { ProductImagesRepository } from './repositories/product-images.repository.js';

/**
 * Imports `ProductsModule` for `ProductsRepository`, which `ProductImagesService`
 * uses to confirm the owning product exists without duplicating any SQL for
 * `products` or reaching into another aggregate's table.
 *
 * The edge runs one way — ProductImages -> Products — so the module graph stays
 * acyclic. Note that `ProductsModule` does **not** import this one: the image
 * gallery is reached through the nested route, not by injecting an image service
 * into the product feature.
 *
 * `CloudinaryService` needs **no** import: `CloudinaryModule` is `@Global` and
 * exports exactly that one provider, so the upload and delete paths reach
 * Cloudinary through the existing global edge without a new module dependency.
 * Anything else from that module — the SDK client, the credentials — stays
 * unexported, so this feature cannot inject them even if it tried to.
 *
 * Exports `ProductImagesService`, for `AdminProductImagesController`. An
 * administrator uploading or promoting an image is doing the same operation a
 * public route does, and the parts that are easy to get subtly wrong — reading
 * `imageUrl` and `publicId` off Cloudinary's response instead of the request,
 * the compensating delete when the row insert fails, the swap that demotes the
 * incumbent primary, refusing to delete or clear the only primary — all live in
 * this service. A second implementation of the image rules would be a second
 * place for the single-primary invariant and the orphaned-asset compensation to
 * be wrong, and would be a second Cloudinary integration.
 *
 * The repository stays unexported: no other module needs image persistence, and
 * the ownership chain (product -> image) is enforced inside the service rather
 * than left for a caller to reproduce.
 *
 * `PrismaService` arrives without an explicit import because `PrismaModule` is
 * `@Global`.
 */
@Module({
  imports: [ProductsModule],
  controllers: [ProductImagesController],
  providers: [ProductImagesService, ProductImagesRepository],
  exports: [ProductImagesService],
})
export class ProductImagesModule {}
