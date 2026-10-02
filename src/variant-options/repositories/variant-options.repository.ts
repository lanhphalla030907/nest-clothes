import { Injectable } from '@nestjs/common';
import type { VariantOption } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * The exact columns `VariantOptionsRepository.create` is allowed to write.
 *
 * `id`, `createdAt` and `updatedAt` are absent because they are database-owned
 * and must never be reachable from a request payload.
 *
 * `variantId` is present because an option cannot exist without an owner; the
 * service always fills it from the URL rather than from the body.
 */
export interface CreateVariantOptionData {
  variantId: string;
  optionName: string;
  optionValue: string;
}

/**
 * The subset of columns a `PATCH` may write. Absent keys are left untouched.
 *
 * `variantId` is missing on purpose: ownership is fixed at creation, so no public
 * write can move an option to another variant.
 */
export interface UpdateVariantOptionData {
  optionName?: string;
  optionValue?: string;
}

/**
 * The only place in the variant-options feature that talks to the database.
 *
 * It owns VariantOption persistence and nothing else: no normalisation, no
 * ownership reasoning, no duplicate-name reasoning, no exception mapping, no DTO
 * mapping, no HTTP status decisions. That keeps the SQL surface of the
 * VariantOption aggregate in one auditable file and lets the service express
 * *what* it needs without knowing the query shape.
 *
 * Variant and product rows are reached through `ProductVariantsRepository` and
 * `ProductsRepository`, never from here, so this file never joins or filters
 * across aggregates.
 */
@Injectable()
export class VariantOptionsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Persists a new option and returns the stored entity. */
  create(data: CreateVariantOptionData): Promise<VariantOption> {
    return this.prisma.variantOption.create({ data });
  }

  /**
   * Returns every option belonging to `variantId`, insertion order.
   *
   * `createdAt` ascending reflects the order a merchant configured the axes in,
   * and `id` breaks ties so two options created in the same transaction still
   * come back in a stable order between identical requests. Without it the
   * listing, and any pagination added later, would be non-deterministic.
   */
  findAllByVariantId(variantId: string): Promise<VariantOption[]> {
    return this.prisma.variantOption.findMany({
      where: { variantId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  /**
   * Returns the option `id` only when it belongs to `variantId`, else `null`.
   *
   * Filtering by owner in the query — rather than fetching by id and comparing in
   * the service — means a caller cannot distinguish "no such option" from "that
   * option belongs to another variant", which is what lets both answer 404
   * without leaking the existence of another variant's option.
   */
  findByIdAndVariantId(
    id: string,
    variantId: string,
  ): Promise<VariantOption | null> {
    return this.prisma.variantOption.findFirst({
      where: { id, variantId },
    });
  }

  /**
   * Returns the option on `variantId` whose name matches `optionName` under
   * case-insensitive comparison, or `null` when there is none.
   *
   * `mode: 'insensitive'` is used rather than a compound unique lookup because the
   * unique constraint that makes this true is a functional index on
   * `lower(option_name)`, which Prisma cannot address from a generated `where`.
   * The query mirrors what that index enforces.
   */
  findByVariantIdAndOptionName(
    variantId: string,
    optionName: string,
  ): Promise<VariantOption | null> {
    return this.prisma.variantOption.findFirst({
      where: {
        variantId,
        optionName: { equals: optionName, mode: 'insensitive' },
      },
    });
  }

  /**
   * Writes only the columns present in `data`, so an update can never
   * accidentally overwrite an unrelated column with an undefined value.
   *
   * Rejects with Prisma's `P2025` when `id` does not exist; the service resolves
   * ownership first so that maps to a 404.
   */
  update(id: string, data: UpdateVariantOptionData): Promise<VariantOption> {
    return this.prisma.variantOption.update({ where: { id }, data });
  }

  /** Removes the option owning `id` and returns the row as it was. */
  delete(id: string): Promise<VariantOption> {
    return this.prisma.variantOption.delete({ where: { id } });
  }
}
