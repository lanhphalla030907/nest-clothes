import { Injectable } from '@nestjs/common';
import type { Category } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * The exact columns `CategoriesRepository.create` is allowed to write.
 *
 * `id`, `createdAt` and `updatedAt` are intentionally missing: they are
 * database-owned and must never be reachable from a request payload.
 */
export interface CreateCategoryData {
  name: string;
  slug: string;
  description: string | null;
  parentId: string | null;
  isActive: boolean;
}

/** The subset of columns a `PATCH` may write. Absent keys are left untouched. */
export interface UpdateCategoryData {
  name?: string;
  slug?: string;
  description?: string | null;
  parentId?: string | null;
  isActive?: boolean;
}

/**
 * The only place in the categories feature that talks to the database.
 *
 * It owns Category persistence and nothing else: no normalisation, no
 * uniqueness reasoning, no exception mapping, no DTO mapping. That keeps the SQL
 * surface of the Category aggregate in one auditable file and lets the service
 * express *what* it needs without knowing the query shape.
 *
 * The methods below are the complete set required by the application today.
 * It is deliberately not generalised into a base class or generic CRUD helper —
 * each method states exactly which columns and filters it touches.
 */
@Injectable()
export class CategoriesRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Persists a new category and returns the stored entity. */
  create(data: CreateCategoryData): Promise<Category> {
    return this.prisma.category.create({ data });
  }

  /**
   * Returns every category, ordered by name.
   *
   * The ordering is part of the contract: it makes the listing deterministic
   * and renders naturally in a catalog navigation without an extra sort in the
   * client. Inactive categories are included because listing is an
   * administrative read, not the storefront browse.
   */
  findAll(): Promise<Category[]> {
    return this.prisma.category.findMany({ orderBy: { name: 'asc' } });
  }

  /** Returns the category owning `id`, or `null` when no such category exists. */
  findById(id: string): Promise<Category | null> {
    return this.prisma.category.findUnique({ where: { id } });
  }

  /** Returns the category owning `slug`, or `null` when no such category exists. */
  findBySlug(slug: string): Promise<Category | null> {
    return this.prisma.category.findUnique({ where: { slug } });
  }

  /**
   * Writes only the columns present in `data`, so an update can never
   * accidentally overwrite an unrelated column with an undefined value.
   *
   * Rejects with Prisma's `P2025` when `id` does not exist; the service
   * resolves existence first so that maps to a 404.
   */
  update(id: string, data: UpdateCategoryData): Promise<Category> {
    return this.prisma.category.update({ where: { id }, data });
  }

  /**
   * Removes the leaf category owning `id`.
   *
   * There is no cascade here on purpose. `categories.parent_id` is declared
   * `ON DELETE RESTRICT`, so PostgreSQL itself refuses to orphan children; the
   * service turns that refusal into a 409 before it is ever reached.
   */
  delete(id: string): Promise<Category> {
    return this.prisma.category.delete({ where: { id } });
  }

  /**
   * Counts the direct children of `parentId`.
   *
   * A cheap `count` rather than loading the rows: the caller only needs to know
   * whether the category is a leaf, and `categories_parent_id_idx` serves the
   * filter directly.
   */
  countChildren(parentId: string): Promise<number> {
    return this.prisma.category.count({ where: { parentId } });
  }

  /**
   * Walks the `parent_id` chain upwards from `categoryId` and returns every
   * ancestor id, nearest first.
   *
   * The walk is iterative (one query per level) rather than a recursive CTE
   * because hierarchies are three levels deep in this catalog and a cycle
   * cannot be written through the service, so the query would never grow.
   *
   * `visited` is a cheap safety net: it bounds the walk even if the stored data
   * were already cyclic through some other writer.
   */
  async findAncestorIds(categoryId: string): Promise<string[]> {
    const ancestorIds: string[] = [];
    const visited = new Set<string>([categoryId]);

    let current = await this.findById(categoryId);

    while (current !== null && current.parentId !== null) {
      if (visited.has(current.parentId)) {
        break;
      }

      visited.add(current.parentId);
      ancestorIds.push(current.parentId);
      current = await this.findById(current.parentId);
    }

    return ancestorIds;
  }
}