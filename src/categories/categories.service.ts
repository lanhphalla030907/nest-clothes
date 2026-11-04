import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { normalizeCategoryName } from '../common/utils/normalize-category-name.js';
import { normalizeSlug } from '../common/utils/normalize-slug.js';
import { CloudinaryService } from '../cloudinary/cloudinary.service.js';
import {
  Prisma,
  type Category,
} from '../generated/prisma/client.js';
import { CategoryResponseDto } from './dto/category-response.dto.js';
import { CreateCategoryDto } from './dto/create-category.dto.js';
import { UpdateCategoryDto } from './dto/update-category.dto.js';
import { UploadCategoryImageDto } from './dto/upload-category-image.dto.js';
import type { UploadedCategoryImageFile } from './interfaces/uploaded-category-image-file.js';
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
  constructor(
    private readonly categoriesRepository: CategoriesRepository,
    private readonly cloudinaryService: CloudinaryService,
  ) {}

  private readonly logger = new Logger(CategoriesService.name);

  async create(dto: CreateCategoryDto): Promise<CategoryResponseDto> {
    const data: CreateCategoryData = {
      name: normalizeCategoryName(dto.name),
      slug: normalizeSlug(dto.slug),
      description: this.normalizeDescription(dto.description),
      parentId: dto.parentId ?? null,
      isActive: dto.isActive ?? true,
      imageUrl: null,
      publicId: null,
      altText: null,
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
   * Uploads an image for `id` and records its Cloudinary metadata on the
   * category.
   *
   * A remote upload and a local write cannot share a transaction, so the order
   * of operations is the whole design:
   *
   * 1. The category is confirmed to exist — before anything is uploaded, so a
   *    typo in the path costs a database read rather than a wasted asset.
   * 2. The file is validated by `CloudinaryService`, which refuses an empty,
   *    oversized or non-image payload before a single byte leaves the process.
   * 3. The bytes go to Cloudinary.
   * 4. `imageUrl` and `publicId` are read **off the upload result**, never off
   *    the request. The client has no way to influence either.
   * 5. The category record is updated with the new image metadata.
   * 6. If step 5 throws, the asset uploaded in step 3 is deleted before the
   *    error propagates, so no orphaned asset is left behind.
   * 7. Only after the category record is updated is the previous Cloudinary
   *    asset (if any) deleted. The category never points at a deleted asset:
   *    the new row is in place before the old asset is removed.
   */
  async uploadImage(
    id: string,
    file: UploadedCategoryImageFile | undefined,
    dto: UploadCategoryImageDto,
  ): Promise<CategoryResponseDto> {
    const existing = await this.requireCategory(id);
    const previousPublicId = existing.publicId;
    const uploadedFile = this.assertFileIsPresent(file);

    const uploaded = await this.cloudinaryService.upload({
      buffer: uploadedFile.buffer,
      mimeType: uploadedFile.mimetype,
    });

    const data: UpdateCategoryData = {
      imageUrl: uploaded.secureUrl,
      publicId: uploaded.publicId,
      altText: this.normalizeAltText(dto.altText),
    };

    let category: Category;

    try {
      category = await this.categoriesRepository.update(id, data);
    } catch (error) {
      await this.compensateFailedUpload(uploaded.publicId, error);

      throw error;
    }

    /**
     * The previous Cloudinary asset is deleted only after the category record
     * points at the new one. If this delete fails the category already holds the
     * new asset, so the worst case is an orphaned old asset — visible and
     * repairable — rather than a category that references a deleted image.
     */
    if (previousPublicId && previousPublicId !== uploaded.publicId) {
      await this.cloudinaryService.deleteAsset(previousPublicId).catch((error) => {
        this.logger.error(
          `Failed to remove previous Cloudinary asset ${previousPublicId} after category image replacement: ${error}`,
        );
      });
    }

    return CategoryResponseDto.fromEntity(category);
  }

  /**
   * Removes a category's image: clears the database fields first, then deletes
   * the Cloudinary asset.
   *
   * The order is deliberate. Clearing the database first means the category can
   * never reference a deleted asset — even if Cloudinary deletion fails, the
   * row no longer points at anything. Deleting the Cloudinary asset second
   * means the worst case of a Cloudinary failure is an orphaned asset in the
   * account (visible, repairable, billable) rather than a broken reference on
   * the category row (invisible, unrecoverable through the API).
   *
   * If the database update fails, the Cloudinary asset is never touched: the
   * category still references a live asset, which is consistent and safe.
   *
   * If Cloudinary deletion fails, the error is logged and swallowed. The
   * `publicId` was already cleared from the category row, so the asset becomes
   * an unrecoverable orphan in Cloudinary. This is the lesser of two evils:
   * a billing leak is preferable to a dangling reference that no caller can
   * repair. Operators can reclaim orphaned assets through the Cloudinary
   * dashboard or a cleanup job.
   */
  async removeImage(id: string): Promise<void> {
    const category = await this.requireCategory(id);

    if (category.publicId === null) {
      return;
    }

    const publicId = category.publicId;

    await this.categoriesRepository.update(id, {
      imageUrl: null,
      publicId: null,
      altText: null,
    });

    /**
     * Delete the Cloudinary asset only after the database fields are cleared.
     * A failure here leaves an orphaned asset in Cloudinary, but the category
     * row no longer references it — so nothing is broken for callers.
     */
    await this.cloudinaryService.deleteAsset(publicId).catch((error) => {
      this.logger.error(
        `Failed to remove Cloudinary asset ${publicId} after clearing category ${id} image fields; the asset must be deleted manually (error: ${this.describe(error)})`,
      );
    });
  }

  /**
   * Builds the update payload from the fields the client actually sent.
   *
   * An absent key is left out of the object entirely so Prisma never writes an
   * `undefined` column, while an explicit `null` is forwarded and therefore
   * clears `description` or detaches `parentId`.
   *
   * Image fields (`imageUrl`, `publicId`, `altText`) are absent from this
   * method on purpose: they are written only by {@link uploadImage} and
   * {@link removeImage}, never by a metadata PATCH. The client cannot forge
   * them through `PATCH /categories/:id`.
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

  /**
   * Rejects a request that carried no usable file part, and returns the file so
   * the caller does not have to narrow the type itself.
   */
  private assertFileIsPresent(
    file: UploadedCategoryImageFile | undefined,
  ): UploadedCategoryImageFile {
    if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
      throw new BadRequestException(
        'An image file is required in the "file" field',
      );
    }

    return file;
  }

  /**
   * Deletes an orphaned asset after its database update failed, then rethrows
   * the original error.
   *
   * Without this, a rejected update leaves the file uploaded in Cloudinary with
   * no category row referencing it. The `publicId` is the only pointer, and it
   * was never stored, so nothing else would ever find it.
   *
   * The compensation failure is logged and swallowed, never propagated. The
   * caller needs the *original* database error.
   */
  private async compensateFailedUpload(
    publicId: string,
    originalError: unknown,
  ): Promise<void> {
    try {
      await this.cloudinaryService.deleteAsset(publicId);
    } catch (compensationError) {
      this.logger.error(
        `Failed to remove orphaned Cloudinary asset ${publicId} after a category database error; it must be deleted manually (original error: ${this.describe(originalError)}, cleanup error: ${this.describe(compensationError)})`,
      );
    }
  }

  /** Renders an unknown thrown value for a log line, without assuming a shape. */
  private describe(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return typeof error === 'string' ? error : 'unknown error';
  }

  private normalizeAltText(altText?: string | null): string | null {
    return altText === undefined || altText === null ? null : altText.trim();
  }
}