import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { normalizeCategoryName } from '../common/utils/normalize-category-name.js';
import { normalizeSlug } from '../common/utils/normalize-slug.js';
import {
  Prisma,
  type Category,
} from '../generated/prisma/client.js';
import { CategoryResponseDto } from './dto/category-response.dto.js';
import { CreateCategoryDto } from './dto/create-category.dto.js';
import { UpdateCategoryDto } from './dto/update-category.dto.js';
import {
  CategoriesRepository,
  type CreateCategoryData,
  type UpdateCategoryData,
} from './repositories/categories.repository.js';

const PRISMA_UNIQUE_CONSTRAINT_VIOLATION = 'P2002';
const PRISMA_FOREIGN_KEY_CONSTRAINT_VIOLATION = 'P2003';
const CATEGORY_MODEL = 'Category';
const SLUG_FIELD = 'slug';
const DUPLICATE_SLUG_MESSAGE = 'A category with this slug already exists';
const CATEGORY_HAS_CHILDREN_MESSAGE =
  'Category cannot be deleted while it still has child categories';

/**
 * All category business rules live here; the repository only knows about SQL
 * and this controller only knows about HTTP.
 *
 * ## Error semantics
 *
 * The mapping below is applied consistently and is the only place where a
 * database error becomes an HTTP one. Anything not listed here propagates
 * untouched so that genuine faults are never disguised as client errors.
 *
 * | Condition                                | Status | Rationale                                                       |
 * | ---------------------------------------- | ------ | --------------------------------------------------------------- |
 * | Category does not exist                  | 404    | The addressed resource is absent.                               |
 * | `parentId` does not exist                | 404    | `parentId` references another resource, so it gets the same 404. |
 * | Duplicate `slug`                         | 409    | The request collides with an existing uniqueness constraint.     |
 * | `parentId` refers to an inactive parent  | 409    | Valid target, but it conflicts with the current state.           |
 * | Circular hierarchy                       | 409    | The hierarchy in the database already rules this out.           |
 * | Delete while children exist              | 409    | The request collides with stored rows.                           |
 * | `parentId` equals the category itself    | 400    | Self-referencing payload is malformed regardless of stored data. |
 */
@Injectable()
export class CategoriesService {
  constructor(private readonly categoriesRepository: CategoriesRepository) {}

  async create(dto: CreateCategoryDto): Promise<CategoryResponseDto> {
    const data: CreateCategoryData = {
      name: normalizeCategoryName(dto.name),
      slug: normalizeSlug(dto.slug),
      description: this.normalizeDescription(dto.description),
      parentId: dto.parentId ?? null,
      isActive: dto.isActive ?? true,
    };

    await this.assertSlugAvailable(data.slug);
    await this.assertParentAssignable(data.parentId);

    try {
      const category = await this.categoriesRepository.create(data);

      return CategoryResponseDto.fromEntity(category);
    } catch (error) {
      this.rethrowAsHttpError(error);
    }
  }

  async findAll(): Promise<CategoryResponseDto[]> {
    const categories = await this.categoriesRepository.findAll();

    return categories.map((category) => CategoryResponseDto.fromEntity(category));
  }

  async findOne(id: string): Promise<CategoryResponseDto> {
    const category = await this.requireCategory(id);

    return CategoryResponseDto.fromEntity(category);
  }

  async update(
    id: string,
    dto: UpdateCategoryDto,
  ): Promise<CategoryResponseDto> {
    await this.requireCategory(id);

    const data = this.buildUpdateData(dto);

    if (dto.slug !== undefined) {
      await this.assertSlugAvailable(normalizeSlug(dto.slug), id);
    }

    if (dto.parentId !== undefined) {
      this.assertNotSelfParent(id, dto.parentId);
      await this.assertParentAssignable(dto.parentId);
      await this.assertNoCircularHierarchy(id, dto.parentId);
    }

    try {
      const category = await this.categoriesRepository.update(id, data);

      return CategoryResponseDto.fromEntity(category);
    } catch (error) {
      this.rethrowAsHttpError(error);
    }
  }

  async remove(id: string): Promise<void> {
    await this.requireCategory(id);

    const childCount = await this.categoriesRepository.countChildren(id);

    if (childCount > 0) {
      throw new ConflictException(CATEGORY_HAS_CHILDREN_MESSAGE);
    }

    try {
      await this.categoriesRepository.delete(id);
    } catch (error) {
      this.rethrowDeleteError(error);
    }
  }

  /**
   * Builds the update payload from the fields the client actually sent.
   *
   * An absent key is left out of the object entirely so Prisma never writes an
   * `undefined` column, while an explicit `null` is forwarded and therefore
   * clears `description` or detaches `parentId`.
   */
  private buildUpdateData(dto: UpdateCategoryDto): UpdateCategoryData {
    const data: UpdateCategoryData = {};

    if (dto.name !== undefined) {
      data.name = normalizeCategoryName(dto.name);
    }

    if (dto.slug !== undefined) {
      data.slug = normalizeSlug(dto.slug);
    }

    if (dto.description !== undefined) {
      data.description = this.normalizeDescription(dto.description);
    }

    if (dto.parentId !== undefined) {
      data.parentId = dto.parentId;
    }

    if (dto.isActive !== undefined) {
      data.isActive = dto.isActive;
    }

    return data;
  }

  private normalizeDescription(description?: string | null): string | null {
    return description === undefined || description === null
      ? null
      : description.trim();
  }

  /** Loads a category or rejects the request with 404. */
  private async requireCategory(id: string): Promise<Category> {
    const category = await this.categoriesRepository.findById(id);

    if (category === null) {
      throw new NotFoundException(`Category ${id} does not exist`);
    }

    return category;
  }

  /**
   * Rejects a duplicate slug with 409.
   *
   * This is a pre-flight check so the client gets a deterministic message
   * instead of a constraint violation. It cannot fully replace the `P2002`
   * mapping in {@link rethrowAsHttpError}: two concurrent requests can both pass
   * this check, and only the database can settle the race.
   *
   * `excludeId` lets an update keep its own slug without colliding with itself.
   */
  private async assertSlugAvailable(slug: string, excludeId?: string): Promise<void> {
    const existing = await this.categoriesRepository.findBySlug(slug);

    if (existing !== null && existing.id !== excludeId) {
      throw new ConflictException(DUPLICATE_SLUG_MESSAGE);
    }
  }

  /**
   * Validates a proposed `parentId`.
   *
   * `null` is always valid and produces a root category. Otherwise the parent
   * must exist (404) and must be active (409) — nesting under a deactivated
   * category would expose a child that its own parent hides.
   */
  private async assertParentAssignable(
    parentId: string | null,
  ): Promise<void> {
    if (parentId === null) {
      return;
    }

    const parent = await this.categoriesRepository.findById(parentId);

    if (parent === null) {
      throw new NotFoundException(`Parent category ${parentId} does not exist`);
    }

    if (!parent.isActive) {
      throw new ConflictException(
        `Parent category ${parent.slug} is not active`,
      );
    }
  }

  /** Rejects `parentId === id`, which would make a category its own parent. */
  private assertNotSelfParent(categoryId: string, parentId: string | null): void {
    if (parentId === categoryId) {
      throw new BadRequestException('A category cannot be its own parent');
    }
  }

  /**
   * Rejects a re-parent that would close a cycle.
   *
   * `categoryId` would become an ancestor of the proposed parent, so the
   * resulting chain `categoryId -> ... -> parentId -> categoryId` could never be
   * walked. The repository returns the proposed parent's ancestors, so the check
   * is a single membership test.
   */
  private async assertNoCircularHierarchy(
    categoryId: string,
    parentId: string | null,
  ): Promise<void> {
    if (parentId === null) {
      return;
    }

    const ancestorIds =
      await this.categoriesRepository.findAncestorIds(parentId);

    if (ancestorIds.includes(categoryId)) {
      throw new ConflictException(
        'A category cannot be nested under one of its own descendants',
      );
    }
  }

  /**
   * Translates the one Prisma error this feature can legitimately produce on a
   * write into HTTP semantics, and rethrows everything else unchanged.
   *
   * Only `P2002` on the slug is mapped here. Any other known request error — a
   * connection failure, a deadlock, a missing table — is a genuine fault and is
   * allowed to surface as a 500 rather than being laundered into a 4xx.
   */
  private rethrowAsHttpError(error: unknown): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === PRISMA_UNIQUE_CONSTRAINT_VIOLATION &&
      this.isSlugUniqueViolation(error)
    ) {
      throw new ConflictException(DUPLICATE_SLUG_MESSAGE);
    }

    throw error;
  }

  /**
   * Delete-specific mapping, on top of {@link rethrowAsHttpError}.
   *
   * `countChildren()` and `delete()` are not atomic: a child inserted between
   * the two would slip past the pre-check. PostgreSQL still refuses the delete
   * because `categories.parent_id` is `ON DELETE RESTRICT`, and that refusal
   * arrives as `P2003`.
   *
   * `P2003` is deliberately translated *only* here. On a create or an update it
   * means something else entirely — most likely the parent row was deleted in a
   * concurrent request — and reporting it as "cannot delete while it has
   * children" would send the caller chasing the wrong problem.
   */
  private rethrowDeleteError(error: unknown): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === PRISMA_FOREIGN_KEY_CONSTRAINT_VIOLATION
    ) {
      throw new ConflictException(CATEGORY_HAS_CHILDREN_MESSAGE);
    }

    this.rethrowAsHttpError(error);
  }

  /**
   * Detects a unique constraint violation on `categories.slug`.
   *
   * Prisma only populates `meta.target` for engines that report it. With driver
   * adapters such as `@prisma/adapter-pg` the meta object carries only
   * `modelName` and `driverAdapterError`, so the model name is used as the
   * fallback. `slug` is currently the only unique constraint on `categories`;
   * if another one is added this check must be narrowed accordingly.
   */
  private isSlugUniqueViolation(error: Prisma.PrismaClientKnownRequestError): boolean {
    const meta = error.meta;
    const target = meta?.['target'];

    if (Array.isArray(target)) {
      return target.includes(SLUG_FIELD);
    }

    if (typeof target === 'string') {
      return target === SLUG_FIELD;
    }

    return meta?.['modelName'] === CATEGORY_MODEL;
  }
}