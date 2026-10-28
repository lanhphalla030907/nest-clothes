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
} from '@nestjs/common';
import { CreateProductImageDto } from './dto/create-product-image.dto.js';
import { ProductImageResponseDto } from './dto/product-image-response.dto.js';
import { UpdateProductImageDto } from './dto/update-product-image.dto.js';
import { UploadProductImageDto } from './dto/upload-product-image.dto.js';
import { ProductImageUploadInterceptor } from './interceptors/product-image-upload.interceptor.js';
import type { UploadedImageFile } from './interfaces/uploaded-image-file.js';
import { ProductImagesService } from './product-images.service.js';

/**
 * HTTP routing only: parse the request through the pipes and DTOs, delegate to
 * `ProductImagesService`, return its result. No business rules and no database
 * access live here.
 *
 * The controller is mounted under `/products/:productId/images`, so every image
 * is addressed through the product that owns it. Both path parameters run through
 * `ParseUUIDPipe`, which rejects a malformed id with 400 before the service is
 * reached — so the service only ever sees well-formed identifiers, and 404 stays
 * reserved for a well-formed id that does not exist or does not belong to the
 * product in the path.
 *
 * ## Two ways to create an image, on purpose
 *
 * | Route                                            | Body                          | `publicId`      |
 * | ------------------------------------------------ | ----------------------------- | --------------- |
 * | `POST /products/:productId/images`              | JSON metadata (Phase 4A)      | client-supplied |
 * | `POST /products/:productId/images/upload`       | multipart file + optional text| Cloudinary's    |
 *
 * These cannot be the same route. Nest dispatches on path *and* method, so two
 * handlers on `POST /products/:productId/images` means the second is unreachable —
 * and collapsing them into one handler would mean the upload path also accepts
 * `imageUrl`/`publicId` in JSON, which is the one thing the upload route must never
 * do. They are therefore separate paths with separate contracts, and the metadata
 * route keeps its Phase 4A behaviour untouched.
 *
 * The multipart boundary is {@link ProductImageUploadInterceptor}, shared with
 * `AdminProductImagesController` so both routes admit exactly the same files.
 */
@Controller('products/:productId/images')
export class ProductImagesController {
  constructor(private readonly productImagesService: ProductImagesService) {}

  /**
   * Uploads an image file and records it against the product.
   *
   * Returns 201 with the created row. The response shape is the same
   * `ProductImageResponseDto` as every other image route, so a client does not have
   * to special-case this one.
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

  @Patch(':imageId')
  update(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Param('imageId', ParseUUIDPipe) imageId: string,
    @Body() dto: UpdateProductImageDto,
  ): Promise<ProductImageResponseDto> {
    return this.productImagesService.update(productId, imageId, dto);
  }

  /**
   * Deletes an image: the Cloudinary asset first, then the metadata row.
   *
   * The 204 is unchanged from the metadata-only phase; the caller cannot tell from
   * the status which of the two systems was slower. A primary image is still
   * refused with 409, and a Cloudinary failure still leaves the row in place.
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
