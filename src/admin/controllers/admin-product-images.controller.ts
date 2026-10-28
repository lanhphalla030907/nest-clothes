import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UploadedFile,
  UseInterceptors,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../auth/guards/roles.guard.js';
import { Role } from '../../generated/prisma/enums.js';
import { CreateProductImageDto } from '../../product-images/dto/create-product-image.dto.js';
import { ProductImageResponseDto } from '../../product-images/dto/product-image-response.dto.js';
import { UpdateProductImageDto } from '../../product-images/dto/update-product-image.dto.js';
import { UploadProductImageDto } from '../../product-images/dto/upload-product-image.dto.js';
import { ProductImageUploadInterceptor } from '../../product-images/interceptors/product-image-upload.interceptor.js';
import type { UploadedImageFile } from '../../product-images/interfaces/uploaded-image-file.js';
import { ProductImagesService } from '../../product-images/product-images.service.js';

/**
 * Administrative product-image management.
 *
 * Every method delegates to {@link ProductImagesService}, which is where the parts of
 * this feature that are easy to get subtly wrong already live and are not restated here:
 *
 * - `imageUrl` and `publicId` are read off Cloudinary's response on the upload path, so a
 *   client cannot forge either, and a failed row insert deletes the uploaded asset.
 * - promotion demotes the incumbent primary in the same transaction, so the product is
 *   never briefly without one;
 * - the only primary image cannot be deleted or have its flag cleared — 409, decided
 *   before any remote call;
 * - an image reached through the wrong product is 404, not 403, so the nested route
 *   cannot be used to probe another product's assets.
 *
 * Ownership is never taken from the request. `productId` comes from the path and every
 * write is scoped to it in the query, so there is no `productId` in a body that could
 * point somewhere else — the metadata create route keeps the one `productId` field its
 * DTO has and still rejects a body that disagrees with the path.
 *
 * The Cloudinary secret is never in scope here: this module injects
 * `ProductImagesService`, which injects `CloudinaryService`, and the credential stays
 * inside that global module. There is one Cloudinary integration in this application and
 * this is not a second one.
 */
@Controller('admin/products/:productId/images')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminProductImagesController {
  constructor(private readonly productImagesService: ProductImagesService) {}

  /**
   * Uploads a file and records it against the product.
   *
   * Shares {@link ProductImageUploadInterceptor} with the public upload route, so the
   * allowed types, the size ceiling and the form field name are one definition rather
   * than two that could drift.
   */
  @Post('upload')
  @UseInterceptors(ProductImageUploadInterceptor)
  upload(
    @Param('productId', ParseUUIDPipe) productId: string,
    @UploadedFile() file: UploadedImageFile | undefined,
    @Body() dto: UploadProductImageDto,
  ): Promise<ProductImageResponseDto> {
    return this.productImagesService.upload(productId, file, dto);
  }

  /** Records image metadata. The URL and public id are the caller's own references. */
  @Post()
  create(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: CreateProductImageDto,
  ): Promise<ProductImageResponseDto> {
    return this.productImagesService.create(productId, dto);
  }

  @Get()
  findAll(
    @Param('productId', ParseUUIDPipe) productId: string,
  ): Promise<ProductImageResponseDto[]> {
    return this.productImagesService.findAllByProductId(productId);
  }

  @Get(':imageId')
  findOne(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('imageId', ParseUUIDPipe) imageId: string,
  ): Promise<ProductImageResponseDto> {
    return this.productImagesService.findOne(productId, imageId);
  }

  /**
   * Updates image metadata, and promotes or demotes the primary.
   *
   * `isPrimary: true` goes through the transactional swap rather than a bare flag write,
   * so promoting never leaves the product with two primaries or none.
   */
  @Patch(':imageId')
  update(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('imageId', ParseUUIDPipe) imageId: string,
    @Body() dto: UpdateProductImageDto,
  ): Promise<ProductImageResponseDto> {
    return this.productImagesService.update(productId, imageId, dto);
  }

  /**
   * Deletes the Cloudinary asset and then the row, in that order.
   *
   * Asset first, because the row is the only record of the `publicId`: the worst case of a
   * database failure is a row pointing at a missing asset, which is visible and
   * repairable, while the other order strands a file that nothing can find.
   */
  @Delete(':imageId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('imageId', ParseUUIDPipe) imageId: string,
  ): Promise<void> {
    return this.productImagesService.remove(productId, imageId);
  }
}