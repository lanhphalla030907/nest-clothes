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
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../auth/guards/roles.guard.js';
import { CategoryResponseDto } from '../../categories/dto/category-response.dto.js';
import { CreateCategoryDto } from '../../categories/dto/create-category.dto.js';
import { UpdateCategoryDto } from '../../categories/dto/update-category.dto.js';
import { CategoriesService } from '../../categories/categories.service.js';
import { Role } from '../../generated/prisma/enums.js';

/**
 * Administrative category management.
 *
 * Every method delegates to {@link CategoriesService} and adds no rule of its own. That
 * is the whole design: an administrator editing a category is doing the same thing a
 * catalogue manager would have done before this module existed, so slug normalisation,
 * the unique-slug 409, the parent-must-be-active rule, the circular-hierarchy refusal and
 * the delete protection are all *the same code* rather than an admin copy that could
 * disagree with the public one.
 *
 * `CategoriesService` already accepts `isActive` on create and update, so an
 * administrator can switch a section on and off without a second code path. What it does
 * not do is skip a rule: an administrator cannot nest under an inactive parent or create
 * a cycle, because the checks are in the service and not in the controller.
 *
 * ## Authorisation
 *
 * `JwtAuthGuard` then `RolesGuard`, with `@Roles(Role.ADMIN)` on the **class** rather than
 * on each handler. Declaring it once at the class level is what makes "a customer cannot
 * reach any of this" a property of the type rather than a review item — there is no
 * handler in this file that can be added without inheriting both guards. The order is
 * load-bearing: the first guard establishes who the caller is, the second asks whether
 * that identity is allowed here.
 */
@Controller('admin/categories')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminCategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  /**
   * Lists every category, active and inactive.
   *
   * `CategoriesService.findAll` includes inactive rows already, which is exactly what a
   * management screen needs: a hidden section has to be visible to the person who can
   * bring it back. Ordering is the service's — by name — so the response is deterministic.
   */
  @Get()
  findAll(): Promise<CategoryResponseDto[]> {
    return this.categoriesService.findAll();
  }

  @Get(':id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CategoryResponseDto> {
    return this.categoriesService.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateCategoryDto): Promise<CategoryResponseDto> {
    return this.categoriesService.create(dto);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCategoryDto,
  ): Promise<CategoryResponseDto> {
    return this.categoriesService.update(id, dto);
  }

  /**
   * Deletes a leaf category.
   *
   * The 409 while children exist, and the 409 the database raises if a child or a product
   * appeared between the check and the delete, both come from the service.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.categoriesService.remove(id);
  }
}