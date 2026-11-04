import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { normalizeMoney } from '../common/utils/normalize-money.js';
import { normalizeName } from '../common/utils/normalize-name.js';
import { normalizeSku } from '../common/utils/normalize-sku.js';
import { availableStock } from '../common/utils/available-stock.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  PreviewProductOptionsDto,
  type ProductOptionDraftDto,
} from './dto/product-option-draft.dto.js';
import {
  MAX_PRODUCT_VARIANTS,
  SaveProductOptionsDto,
} from './dto/save-product-options.dto.js';

const PRODUCT_MATRIX_INCLUDE = {
  options: {
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
    include: {
      values: { orderBy: [{ position: 'asc' }, { id: 'asc' }] },
    },
  },
  variants: {
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: {
      inventory: true,
      options: { orderBy: [{ optionName: 'asc' }, { id: 'asc' }] },
      optionValueMappings: { include: { value: true } },
    },
  },
} satisfies Prisma.ProductInclude;

type ProductMatrix = Prisma.ProductGetPayload<{
  include: typeof PRODUCT_MATRIX_INCLUDE;
}>;
type StoredOption = ProductMatrix['options'][number];
type StoredVariant = ProductMatrix['variants'][number];

export interface ResolvedOptionValue {
  id: string;
  value: string;
  position: number;
}

export interface ResolvedOption {
  id: string;
  name: string;
  position: number;
  values: ResolvedOptionValue[];
}

interface MatrixCombination {
  key: string;
  optionValueIds: string[];
  label: string;
}

export interface ProductOptionsConfigurationResponse {
  productId: string;
  revision: number;
  options: Array<
    ResolvedOption & {
      isActive: boolean;
      values: Array<ResolvedOptionValue & { isActive: boolean }>;
    }
  >;
  variants: Array<{
    id: string;
    sku: string;
    price: string;
    isActive: boolean;
    optionValueIds: string[];
    options: Array<{ optionName: string; optionValue: string }>;
    inventory: {
      quantity: number;
      reservedQuantity: number;
      available: number;
    } | null;
  }>;
}

export interface ProductOptionsPreviewResponse {
  expectedRevision: number;
  options: ResolvedOption[];
  variants: Array<{
    id?: string;
    optionValueIds: string[];
    label: string;
    sku: string;
    price: string;
    isActive: boolean;
    available: number | null;
  }>;
}

interface NormalizedVariantDraft {
  id?: string;
  key: string;
  sku: string;
  price: string;
  isActive: boolean;
}

/**
 * Product option definitions and generated variants are one aggregate write.
 * The service owns that transaction so option retirement, variant reuse,
 * inventory preservation and the legacy response projection cannot diverge.
 */
@Injectable()
export class ProductOptionsService {
  constructor(private readonly prisma: PrismaService) {}

  async findByProductId(
    productId: string,
  ): Promise<ProductOptionsConfigurationResponse> {
    const product = await this.findProductMatrix(productId);
    if (product === null) this.throwProductNotFound(productId);

    return this.toConfigurationResponse(product);
  }

  async preview(
    productId: string,
    dto: PreviewProductOptionsDto,
  ): Promise<ProductOptionsPreviewResponse> {
    const product = await this.findProductMatrix(productId);
    if (product === null) this.throwProductNotFound(productId);

    const options = this.resolveOptions(dto.options, product.options);
    const combinations = this.createCombinations(options);
    const existing = this.indexExistingVariants(product.variants);

    return {
      expectedRevision: product.optionsRevision,
      options,
      variants: combinations.map((combination) => {
        const variant = existing.get(combination.key);
        return {
          ...(variant === undefined ? {} : { id: variant.id }),
          optionValueIds: combination.optionValueIds,
          label: combination.label,
          sku: variant?.sku ?? '',
          price: variant?.price.toFixed(2) ?? product.basePrice.toFixed(2),
          isActive: variant?.isActive ?? true,
          available:
            variant?.inventory === null || variant?.inventory === undefined
              ? null
              : availableStock(variant.inventory),
        };
      }),
    };
  }

  async save(
    productId: string,
    dto: SaveProductOptionsDto,
  ): Promise<ProductOptionsConfigurationResponse> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<{ options_revision: number }[]>`
          SELECT "options_revision"
          FROM "products"
          WHERE "id" = ${productId}::uuid
          FOR UPDATE
        `;
        if (locked.length === 0) this.throwProductNotFound(productId);

        const product = await tx.product.findUnique({
          where: { id: productId },
          include: PRODUCT_MATRIX_INCLUDE,
        });
        if (product === null) this.throwProductNotFound(productId);

        if (product.optionsRevision !== dto.expectedRevision) {
          throw new ConflictException(
            'Product options changed since they were loaded. Reload and review the variants before saving.',
          );
        }

        const options = this.resolveOptions(dto.options, product.options);
        const combinations = this.createCombinations(options);
        const drafts = this.validateVariantDrafts(
          dto.variants,
          combinations,
          options,
        );
        const existingByCombination = this.indexExistingVariants(
          product.variants,
        );
        const retainedIds = drafts.flatMap((draft) => {
          const existing = existingByCombination.get(draft.key);
          return existing === undefined ? [] : [existing.id];
        });
        await this.assertSkusAvailable(tx, drafts, retainedIds);

        await this.persistOptions(tx, productId, options, product.options);

        const savedVariantIds = new Set<string>();

        for (const draft of drafts) {
          const combination = combinations.find(
            (item) => item.key === draft.key,
          );
          if (combination === undefined) {
            throw new BadRequestException(
              'A variant refers to a combination that is not in the generated option matrix',
            );
          }

          const existing = existingByCombination.get(combination.key);
          if (draft.id !== undefined && draft.id !== existing?.id) {
            throw new ConflictException(
              'A variant ID can only be retained for its existing option combination',
            );
          }

          const variant = existing
            ? await tx.productVariant.update({
                where: { id: existing.id },
                data: {
                  sku: draft.sku,
                  price: draft.price,
                  isActive: draft.isActive,
                  combinationKey: combination.key,
                },
              })
            : await tx.productVariant.create({
                data: {
                  productId,
                  sku: draft.sku,
                  price: draft.price,
                  isActive: draft.isActive,
                  combinationKey: combination.key,
                },
              });

          savedVariantIds.add(variant.id);

          await tx.variantOptionValue.deleteMany({
            where: { variantId: variant.id },
          });
          if (combination.optionValueIds.length > 0) {
            await tx.variantOptionValue.createMany({
              data: combination.optionValueIds.map((optionValueId) => {
                const value = this.findOptionValue(options, optionValueId);
                return {
                  productId,
                  variantId: variant.id,
                  productOptionId: value.productOptionId,
                  optionValueId,
                };
              }),
            });
          }

          await tx.variantOption.deleteMany({
            where: { variantId: variant.id },
          });
          if (combination.optionValueIds.length > 0) {
            await tx.variantOption.createMany({
              data: combination.optionValueIds.map((optionValueId) => {
                const { option, value } = this.findOptionAndValue(
                  options,
                  optionValueId,
                );
                return {
                  variantId: variant.id,
                  optionName: option.name,
                  optionValue: value.value,
                };
              }),
            });
          }
        }

        const toRetire = product.variants
          .filter(
            (variant) =>
              variant.isActive && !savedVariantIds.has(variant.id),
          )
          .map((variant) => variant.id);
        if (toRetire.length > 0) {
          await tx.productVariant.updateMany({
            where: { id: { in: toRetire } },
            data: { isActive: false },
          });
        }

        const retainedOptionIds = options.map((option) => option.id);
        const retainedValueIds = options.flatMap((option) =>
          option.values.map((value) => value.id),
        );

        await tx.productOption.updateMany({
          where: {
            productId,
            ...(retainedOptionIds.length === 0
              ? {}
              : { id: { notIn: retainedOptionIds } }),
          },
          data: { isActive: false },
        });
        await tx.productOptionValue.updateMany({
          where: {
            productId,
            ...(retainedValueIds.length === 0
              ? {}
              : { id: { notIn: retainedValueIds } }),
          },
          data: { isActive: false },
        });

        await tx.product.update({
          where: { id: productId },
          data: { optionsRevision: { increment: 1 } },
        });

        const saved = await tx.product.findUnique({
          where: { id: productId },
          include: PRODUCT_MATRIX_INCLUDE,
        });
        if (saved === null) this.throwProductNotFound(productId);
        return this.toConfigurationResponse(saved);
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'Option names, values, variant combinations and SKUs must be unique',
        );
      }
      throw error;
    }
  }

  private async findProductMatrix(
    productId: string,
  ): Promise<ProductMatrix | null> {
    return this.prisma.product.findUnique({
      where: { id: productId },
      include: PRODUCT_MATRIX_INCLUDE,
    });
  }

  private resolveOptions(
    drafts: ProductOptionDraftDto[],
    storedOptions: StoredOption[],
  ): ResolvedOption[] {
    const storedById = new Map(storedOptions.map((option) => [option.id, option]));
    const names = new Set<string>();
    const ids = new Set<string>();

    return drafts.map((draft, optionIndex) => {
      const name = normalizeName(draft.name);
      const nameKey = name.toLowerCase();
      if (names.has(nameKey)) {
        throw new BadRequestException('Option names must be unique per product');
      }
      names.add(nameKey);

      const stored =
        (draft.id === undefined ? undefined : storedById.get(draft.id)) ??
        storedOptions.find(
          (option) => option.name.toLowerCase() === nameKey,
        );
      const id = draft.id ?? stored?.id ?? randomUUID();
      if (ids.has(id)) {
        throw new BadRequestException('Option IDs must be unique');
      }
      ids.add(id);

      const storedValues = stored?.values ?? [];
      const valueNames = new Set<string>();
      const valueIds = new Set<string>();
      const values = draft.values.map((valueDraft, valueIndex) => {
        const value = normalizeName(valueDraft.value);
        const valueKey = value.toLowerCase();
        if (valueNames.has(valueKey)) {
          throw new BadRequestException(
            `Values for ${name} must be unique`,
          );
        }
        valueNames.add(valueKey);

        const existingValue =
          (valueDraft.id === undefined
            ? undefined
            : storedValues.find((item) => item.id === valueDraft.id)) ??
          storedValues.find((item) => item.value.toLowerCase() === valueKey);
        const valueId = valueDraft.id ?? existingValue?.id ?? randomUUID();
        if (valueIds.has(valueId)) {
          throw new BadRequestException(
            `Values for ${name} must have unique IDs`,
          );
        }
        valueIds.add(valueId);

        return {
          id: valueId,
          value,
          position: valueIndex,
        };
      });

      return { id, name, position: optionIndex, values };
    });
  }

  private createCombinations(options: ResolvedOption[]): MatrixCombination[] {
    let combinations: string[][] = [[]];

    for (const option of options) {
      if (combinations.length > MAX_PRODUCT_VARIANTS / option.values.length) {
        throw new BadRequestException(
          `This product would generate more than ${MAX_PRODUCT_VARIANTS} variants`,
        );
      }
      combinations = combinations.flatMap((combination) =>
        option.values.map((value) => [...combination, value.id]),
      );
    }

    return combinations.map((optionValueIds) => {
      const key = this.combinationKey(optionValueIds, options);
      const label =
        optionValueIds.length === 0
          ? 'Default'
          : optionValueIds
              .map((id) => {
                const { option, value } = this.findOptionAndValue(options, id);
                return `${option.name}: ${value.value}`;
              })
              .join(' / ');
      return { key, optionValueIds, label };
    });
  }

  private validateVariantDrafts(
    variants: SaveProductOptionsDto['variants'],
    combinations: MatrixCombination[],
    options: ResolvedOption[],
  ): NormalizedVariantDraft[] {
    const combinationsByKey = new Map(
      combinations.map((combination) => [combination.key, combination]),
    );
    const ids = new Set<string>();
    const keys = new Set<string>();

    return variants.map((variant) => {
      const optionValueIds = variant.optionValueIds;
      if (new Set(optionValueIds).size !== optionValueIds.length) {
        throw new BadRequestException(
          'A variant cannot select the same option value more than once',
        );
      }

      const key = this.combinationKey(optionValueIds, options);
      const combination = combinationsByKey.get(key);
      if (
        combination === undefined ||
        combination.optionValueIds.length !== optionValueIds.length ||
        combination.optionValueIds.some((id) => !optionValueIds.includes(id))
      ) {
        throw new BadRequestException(
          'Each variant must select exactly one value for every active option',
        );
      }
      if (keys.has(key)) {
        throw new BadRequestException(
          'Duplicate option combinations are not allowed',
        );
      }
      keys.add(key);

      if (variant.id !== undefined) {
        if (ids.has(variant.id)) {
          throw new BadRequestException('Variant IDs must be unique');
        }
        ids.add(variant.id);
      }

      const sku = normalizeSku(variant.sku);
      return {
        id: variant.id,
        key,
        sku,
        price: normalizeMoney(variant.price),
        isActive: variant.isActive,
      };
    });
  }

  private async assertSkusAvailable(
    tx: Prisma.TransactionClient,
    drafts: NormalizedVariantDraft[],
    retainedIds: string[],
  ): Promise<void> {
    const skus = drafts.map((draft) => draft.sku);
    if (new Set(skus).size !== skus.length) {
      throw new ConflictException('Variant SKUs must be unique');
    }

    const matches = await tx.productVariant.findMany({
      where: {
        sku: { in: skus },
        ...(retainedIds.length === 0 ? {} : { id: { notIn: retainedIds } }),
      },
      select: { sku: true },
    });
    if (matches.length > 0) {
      throw new ConflictException('A variant with this SKU already exists');
    }
  }

  private async persistOptions(
    tx: Prisma.TransactionClient,
    productId: string,
    options: ResolvedOption[],
    storedOptions: StoredOption[],
  ): Promise<void> {
    const storedOptionIds = new Set(storedOptions.map((option) => option.id));
    const storedValuesById = new Map(
      storedOptions.flatMap((option) =>
        option.values.map((value) => [value.id, { option, value }] as const),
      ),
    );

    for (const option of options) {
      const data = {
        name: option.name,
        position: option.position,
        isActive: true,
      };
      if (storedOptionIds.has(option.id)) {
        const existing = storedOptions.find((item) => item.id === option.id);
        if (existing === undefined || existing.productId !== productId) {
          throw new BadRequestException('Option does not belong to this product');
        }
        await tx.productOption.update({ where: { id: option.id }, data });
      } else {
        await tx.productOption.create({
          data: { id: option.id, productId, ...data },
        });
      }

      const storedValueIds = new Set(
        (storedOptions.find((item) => item.id === option.id)?.values ?? []).map(
          (value) => value.id,
        ),
      );
      for (const [position, value] of option.values.entries()) {
        const existingValue = storedValuesById.get(value.id);
        if (storedValueIds.has(value.id)) {
          if (
            existingValue === undefined ||
            existingValue.option.id !== option.id ||
            existingValue.value.productId !== productId
          ) {
            throw new BadRequestException(
              'Option value does not belong to this product option',
            );
          }
          await tx.productOptionValue.update({
            where: { id: value.id },
            data: { value: value.value, position, isActive: true },
          });
        } else {
          if (existingValue !== undefined) {
            throw new BadRequestException(
              'An option value cannot be moved to another product option',
            );
          }
          await tx.productOptionValue.create({
            data: {
              id: value.id,
              productId,
              productOptionId: option.id,
              value: value.value,
              position,
              isActive: true,
            },
          });
        }
      }
    }
  }

  private indexExistingVariants(
    variants: StoredVariant[],
  ): Map<string, StoredVariant> {
    const indexed = new Map<string, StoredVariant>();
    for (const variant of variants) {
      const key =
        variant.optionValueMappings.length > 0
          ? this.mappingCombinationKey(variant.optionValueMappings)
          : variant.options.length === 0 &&
              (variant.combinationKey === 'DEFAULT' ||
                variant.combinationKey === null)
            ? 'DEFAULT'
            : null;
      if (key === null) continue;
      if (indexed.has(key)) {
        throw new ConflictException(
          'Existing variants contain duplicate option combinations; resolve them before saving',
        );
      }
      indexed.set(key, variant);
    }
    return indexed;
  }

  private combinationKey(
    optionValueIds: string[],
    options: ResolvedOption[],
  ): string {
    if (optionValueIds.length === 0) return 'DEFAULT';

    const selections = optionValueIds.map((id) => {
      const { option } = this.findOptionAndValue(options, id);
      return [option.id, id] as const;
    });
    if (selections.length !== options.length) {
      throw new BadRequestException(
        'Each variant must select one value for every active option',
      );
    }

    return createHash('sha256')
      .update(
        JSON.stringify(
          selections.sort(([left], [right]) => left.localeCompare(right)),
        ),
      )
      .digest('hex');
  }

  private mappingCombinationKey(
    mappings: StoredVariant['optionValueMappings'],
  ): string {
    const selections = mappings
      .map((mapping) => [mapping.productOptionId, mapping.optionValueId] as const)
      .sort(([left], [right]) => left.localeCompare(right));
    return createHash('sha256').update(JSON.stringify(selections)).digest('hex');
  }

  private findOptionValue(
    options: ResolvedOption[],
    optionValueId: string,
  ): { productOptionId: string } {
    const result = this.findOptionAndValue(options, optionValueId);
    return { productOptionId: result.option.id };
  }

  private findOptionAndValue(
    options: ResolvedOption[],
    optionValueId: string,
  ): { option: ResolvedOption; value: ResolvedOptionValue } {
    for (const option of options) {
      const value = option.values.find((item) => item.id === optionValueId);
      if (value !== undefined) return { option, value };
    }
    throw new BadRequestException('Unknown option value in variant combination');
  }

  private toConfigurationResponse(
    product: ProductMatrix,
  ): ProductOptionsConfigurationResponse {
    return {
      productId: product.id,
      revision: product.optionsRevision,
      options: product.options.map((option) => ({
        id: option.id,
        name: option.name,
        position: option.position,
        isActive: option.isActive,
        values: option.values.map((value) => ({
          id: value.id,
          value: value.value,
          position: value.position,
          isActive: value.isActive,
        })),
      })),
      variants: product.variants.map((variant) => ({
        id: variant.id,
        sku: variant.sku,
        price: variant.price.toFixed(2),
        isActive: variant.isActive,
        optionValueIds: variant.optionValueMappings.map(
          (mapping) => mapping.optionValueId,
        ),
        options: variant.optionValueMappings
          .map((mapping) => {
            const option = product.options.find(
              (item) => item.id === mapping.productOptionId,
            );
            const value = option?.values.find(
              (item) => item.id === mapping.optionValueId,
            );
            return option === undefined || value === undefined
              ? null
              : { optionName: option.name, optionValue: value.value };
          })
          .filter((option) => option !== null),
        inventory:
          variant.inventory === null
            ? null
            : {
                quantity: variant.inventory.quantity,
                reservedQuantity: variant.inventory.reservedQuantity,
                available: availableStock(variant.inventory),
              },
      })),
    };
  }

  private throwProductNotFound(productId: string): never {
    throw new NotFoundException(`Product ${productId} does not exist`);
  }
}
