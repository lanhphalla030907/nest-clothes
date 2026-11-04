import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProductOptionsService } from './product-options.service.js';

const combinationKey = (selections: Array<[string, string]>) =>
  createHash('sha256')
    .update(
      JSON.stringify(
        selections.sort(([left], [right]) => left.localeCompare(right)),
      ),
    )
    .digest('hex');

describe('ProductOptionsService', () => {
  let service: ProductOptionsService;
  let findUnique: ReturnType<typeof vi.fn>;

  const product = (overrides: Record<string, unknown> = {}) => ({
    id: 'product-1',
    basePrice: { toFixed: () => '25.00' },
    optionsRevision: 3,
    options: [
      {
        id: 'option-color',
        productId: 'product-1',
        name: 'Color',
        position: 0,
        isActive: true,
        values: [
          {
            id: 'color-black',
            productId: 'product-1',
            productOptionId: 'option-color',
            value: 'Black',
            position: 0,
            isActive: true,
          },
          {
            id: 'color-white',
            productId: 'product-1',
            productOptionId: 'option-color',
            value: 'White',
            position: 1,
            isActive: true,
          },
        ],
      },
      {
        id: 'option-size',
        productId: 'product-1',
        name: 'Size',
        position: 1,
        isActive: true,
        values: [
          {
            id: 'size-s',
            productId: 'product-1',
            productOptionId: 'option-size',
            value: 'S',
            position: 0,
            isActive: true,
          },
          {
            id: 'size-m',
            productId: 'product-1',
            productOptionId: 'option-size',
            value: 'M',
            position: 1,
            isActive: true,
          },
        ],
      },
    ],
    variants: [
      {
        id: 'variant-black-s',
        sku: 'TSHIRT-BLACK-S',
        price: { toFixed: () => '29.00' },
        isActive: true,
        combinationKey: combinationKey([
          ['option-color', 'color-black'],
          ['option-size', 'size-s'],
        ]),
        options: [],
        optionValueMappings: [
          {
            productOptionId: 'option-color',
            optionValueId: 'color-black',
            value: {},
          },
          {
            productOptionId: 'option-size',
            optionValueId: 'size-s',
            value: {},
          },
        ],
        inventory: { quantity: 5, reservedQuantity: 2 },
      },
    ],
    ...overrides,
  });

  beforeEach(async () => {
    findUnique = vi.fn();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductOptionsService,
        {
          provide: PrismaService,
          useValue: { product: { findUnique } },
        },
      ],
    }).compile();
    service = module.get(ProductOptionsService);
  });

  it('previews the Cartesian combinations and retains matching variant details', async () => {
    findUnique.mockResolvedValue(product());

    const result = await service.preview('product-1', {
      options: [
        {
          id: 'option-color',
          name: 'Color',
          values: [
            { id: 'color-black', value: 'Black' },
            { id: 'color-white', value: 'White' },
          ],
        },
        {
          id: 'option-size',
          name: 'Size',
          values: [
            { id: 'size-s', value: 'S' },
            { id: 'size-m', value: 'M' },
          ],
        },
      ],
    });

    expect(result.variants).toHaveLength(4);
    expect(result.variants[0]).toMatchObject({
      id: 'variant-black-s',
      sku: 'TSHIRT-BLACK-S',
      price: '29.00',
      available: 3,
    });
    expect(result.variants.slice(1).every((variant) => variant.id === undefined)).toBe(
      true,
    );
  });

  it('preserves a matching combination when option labels are renamed', async () => {
    findUnique.mockResolvedValue(product());

    const result = await service.preview('product-1', {
      options: [
        {
          id: 'option-color',
          name: 'Shade',
          values: [
            { id: 'color-black', value: 'Midnight' },
            { id: 'color-white', value: 'White' },
          ],
        },
        {
          id: 'option-size',
          name: 'Size',
          values: [
            { id: 'size-s', value: 'S' },
            { id: 'size-m', value: 'M' },
          ],
        },
      ],
    });

    expect(result.variants[0].id).toBe('variant-black-s');
    expect(result.variants[0].label).toBe('Shade: Midnight / Size: S');
  });

  it('rejects a matrix that would exceed the variant cap', async () => {
    findUnique.mockResolvedValue(product({ options: [], variants: [] }));

    await expect(
      service.preview('product-1', {
        options: [
          {
            name: 'Size',
            values: Array.from({ length: 501 }, (_, index) => ({
              value: `Size ${index}`,
            })),
          },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
