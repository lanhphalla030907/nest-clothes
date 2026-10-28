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
  Query,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../auth/guards/roles.guard.js';
import { Role } from '../../generated/prisma/enums.js';
import { AdminCreateProductDto } from '../../products/dto/admin-create-product.dto.js';
import { AdminUpdateProductDto } from '../../products/dto/admin-update-product.dto.js';
import { ProductFilterQueryDto } from '../../products/dto/product-filter-query.dto.js';
import { ProductResponseDto } from '../../products/dto/product-response.dto.js';
import { ProductsService } from '../../products/products.service.js';

/**
 * Administrative product management, including the lifecycle.
 *
 * The catalogue rules — slug normalisation and uniqueness, the category-must-exist and
 * category-must-be-active checks, price and name normalisation — are
 * {@link ProductsService}'s, reached by delegation. What this controller adds is
 * authority, not logic: it is the only place in the application that can express
 * `status` or `isActive` in a request body.
 *
 * ## Why the lifecycle is an argument and not a second service
 *
 * `ProductsService.create` and `update` take an optional `lifecycle` argument. The public
 * DTOs have no such properties, so a public route cannot pass it at all, and the global
 * `ValidationPipe` runs `forbidNonWhitelisted`, so a public `PATCH` that tries is refused
 * with 400 rather than having `status` silently dropped. An admin DTO extends the public
 * one with exactly those two fields, and its route — every handler of which is behind
 * `RolesGuard` — is the only caller that supplies them.
 *
 * The alternative, a separate `AdminProductsService` with its own copy of the slug and
 * category rules, would have been free to disagree with the public one on any of them.
 *
 * ## `status` and `isActive` stay two switches
 *
 * They are independent columns with separate meanings (`products/constants/product-status.constants.ts`
 * is the existing statement of both), so neither is derived from the other here: an
 * administrator may hold an `ACTIVE` product switched off, or keep a `DRAFT` enabled.
 * Only an omitted field is unchanged — a price correction cannot unpublish a product.
 *
 * ## Authorisation
 *
 * `JwtAuthGuard` then `RolesGuard` with `@Roles(Role.ADMIN)` on the class, so every
 * handler in this file inherits both and none can be added without them.
 */
@Controller('admin/products')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminProductsController {
  constructor(private readonly productsService: ProductsService) {}

  /**
   * Lists products, optionally narrowed by status, enablement, category or a search term.
   *
   * Unfiltered this is the same query, in the same order, as the public listing; the
   * filters are the four questions a catalogue manager actually asks. They are validated
   * as input rather than handed to Prisma unchecked, and each one that is absent is not a
   * filter at all.
   */
  @Get()
  findAll(
    @Query() query: ProductFilterQueryDto,
  ): Promise<ProductResponseDto[]> {
    return this.productsService.findMany(query);
  }

  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ProductResponseDto> {
    return this.productsService.findOne(id);
  }

  /**
   * Creates a product, optionally naming its lifecycle up front.
   *
   * Sending neither `status` nor `isActive` produces exactly the product a public create
   * produces — `DRAFT` and enabled — so an administrator who does not think about the
   * lifecycle cannot accidentally publish something by filling in the description.
   */
  @Post()
  create(
    @Body() dto: AdminCreateProductDto,
  ): Promise<ProductResponseDto> {
    return this.productsService.create(dto, dto);
  }

  /**
   * Updates catalogue content and/or the lifecycle.
   *
   * Content is validated and written first, so a rejected slug or category leaves no
   * lifecycle change behind. A request naming neither lifecycle field writes neither
   * column.
   */
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminUpdateProductDto,
  ): Promise<ProductResponseDto> {
    return this.productsService.update(id, dto, dto);
  }

  /**
   * Hard-deletes a product.
   *
   * Its own images, variants, options, stock and attributes cascade away with it. A
   * product still referenced by a wishlist, a cart or an order is refused with 409 — by
   * PostgreSQL, reported by the service — because that is a conflict with stored rows
   * rather than a malformed request. Deactivating it is the alternative that leaves other
   * people's baskets alone.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.productsService.remove(id);
  }
}