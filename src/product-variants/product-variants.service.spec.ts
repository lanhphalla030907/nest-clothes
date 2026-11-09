import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '../generated/prisma/client.js';
import { ProductsRepository } from '../products/repositories/products.repository.js';
import { CreateProductVariantDto } from './dto/create-product-variant.dto.js';
import { UpdateProductVariantDto } from './dto/update-product-variant.dto.js';
import { UpdateVariantCostDto } from './dto/update-variant-cost.dto.js';
import { ProductVariantsService } from './product-variants.service.js';
import { ProductVariantsRepository } from './repositories/product-variants.repository.js';

const PRODUCT_ID = 'a1b2c3d4-e5f6-4f70-8a9b-0c1d2e3f4a5b';
const VARIANT_ID = 'b2c3d4e5-f6a0-4a1b-9c2d-3e4f5a6b7c8d';

const buildCreateDto = (
  overrides: Partial<CreateProductVariantDto> = {},
): CreateProductVariantDto =>
  Object.assign(new CreateProductVariantDto(), {
    sku: '  tshirt-blk-m  ',
    price: '19.99',
    ...overrides,
  });

const buildUpdateDto = (
  overrides: Partial<UpdateProductVariantDto> = {},
): UpdateProductVariantDto =>
  Object.assign(new UpdateProductVariantDto(), overrides);

const buildProduct = (overrides: Record<string, unknown> = {}) => ({
  id: PRODUCT_ID,
  categoryId: 'c-1',
  name: 'Oversized T-Shirt',
  slug: 'oversized-t-shirt',
  description: null,
  basePrice: '19.99',
  status: 'DRAFT',
  isActive: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

const buildVariant = (overrides: Record<string, unknown> = {}) => ({
  id: VARIANT_ID,
  productId: PRODUCT_ID,
  sku: 'TSHIRT-BLK-M',
  price: '19.99',
  isActive: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

const buildUniqueViolation = (code = 'P2002', meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code,
    clientVersion: '7.10.0',
    meta: {
      modelName: 'ProductVariant',
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          originalCode: '23505',
          kind: 'UniqueConstraintViolation',
          constraint: { index: 'product_variants_sku_key' },
          table: 'product_variants',
        },
      },
      ...meta,
    },
  });

describe('ProductVariantsService', () => {
  let service: ProductVariantsService;
  let variantRepoCreateDefault: ReturnType<typeof vi.fn>;
  let variantRepoFindAll: ReturnType<typeof vi.fn>;
  let variantRepoFindBySku: ReturnType<typeof vi.fn>;
  let variantRepoFindByIdAndProductId: ReturnType<typeof vi.fn>;
  let variantRepoUpdateForProduct: ReturnType<typeof vi.fn>;
  let variantRepoUpdateCostForProduct: ReturnType<typeof vi.fn>;
  let variantRepoDelete: ReturnType<typeof vi.fn>;
  let productRepoFindById: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    variantRepoCreateDefault = vi.fn();
    variantRepoFindAll = vi.fn();
    variantRepoFindBySku = vi.fn();
    variantRepoFindByIdAndProductId = vi.fn();
    variantRepoUpdateForProduct = vi.fn();
    variantRepoUpdateCostForProduct = vi.fn();
    variantRepoDelete = vi.fn();
    productRepoFindById = vi.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductVariantsService,
        {
          provide: ProductVariantsRepository,
          useValue: {
            createDefaultIfUnconfigured: variantRepoCreateDefault,
            findAllByProductId: variantRepoFindAll,
            findBySku: variantRepoFindBySku,
            findByIdAndProductId: variantRepoFindByIdAndProductId,
            updateForProduct: variantRepoUpdateForProduct,
            updateCostForProduct: variantRepoUpdateCostForProduct,
            delete: variantRepoDelete,
          },
        },
        {
          provide: ProductsRepository,
          useValue: { findById: productRepoFindById },
        },
      ],
    }).compile();

    service = module.get<ProductVariantsService>(ProductVariantsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    beforeEach(() => {
      productRepoFindById.mockResolvedValue(buildProduct());
      variantRepoFindBySku.mockResolvedValue(null);
      variantRepoCreateDefault.mockImplementation(
        (data: Record<string, unknown>) =>
        Promise.resolve(buildVariant(data)),
      );
    });

    it('creates a valid variant with the product id from the path', async () => {
      const result = await service.create(PRODUCT_ID, buildCreateDto());

      expect(productRepoFindById).toHaveBeenCalledWith(PRODUCT_ID);
      expect(variantRepoCreateDefault).toHaveBeenCalledTimes(1);
      expect(variantRepoCreateDefault.mock.calls[0][0]).toMatchObject({
        productId: PRODUCT_ID,
        sku: 'TSHIRT-BLK-M',
        price: '19.99',
        isActive: true,
        combinationKey: 'DEFAULT',
      });
      expect(result).toMatchObject({
        id: VARIANT_ID,
        productId: PRODUCT_ID,
        sku: 'TSHIRT-BLK-M',
        price: '19.99',
        isActive: true,
      });
    });

    it('normalizes sku by trimming and uppercasing', async () => {
      await service.create(PRODUCT_ID, buildCreateDto({ sku: '  ab-12  ' }));
      expect(variantRepoCreateDefault.mock.calls[0][0].sku).toBe('AB-12');
    });

    it('normalizes price to two decimal places', async () => {
      await service.create(PRODUCT_ID, buildCreateDto({ price: '19.9' }));
      expect(variantRepoCreateDefault.mock.calls[0][0].price).toBe('19.90');
    });

    it('defaults isActive = true when omitted', async () => {
      await service.create(PRODUCT_ID, buildCreateDto());
      expect(variantRepoCreateDefault.mock.calls[0][0].isActive).toBe(true);
    });

    it('honours an explicit isActive = false', async () => {
      await service.create(PRODUCT_ID, buildCreateDto({ isActive: false }));
      expect(variantRepoCreateDefault.mock.calls[0][0].isActive).toBe(false);
    });

    it('missing product → 404 and nothing is written', async () => {
      productRepoFindById.mockResolvedValue(null);

      await expect(
        service.create(PRODUCT_ID, buildCreateDto()),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(variantRepoCreateDefault).not.toHaveBeenCalled();
    });

    it('duplicate sku → 409 before writing', async () => {
      variantRepoFindBySku.mockResolvedValue(buildVariant({ id: 'v-2' }));

      await expect(
        service.create(PRODUCT_ID, buildCreateDto()),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(variantRepoCreateDefault).not.toHaveBeenCalled();
    });

    it('does not create another default variant or bypass configured options', async () => {
      variantRepoCreateDefault.mockResolvedValue(null);

      await expect(
        service.create(PRODUCT_ID, buildCreateDto({ sku: 'OTHER' })),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(variantRepoCreateDefault).toHaveBeenCalledTimes(1);
    });

    it('maps Prisma P2002 on the sku → 409', async () => {
      variantRepoCreateDefault.mockRejectedValue(buildUniqueViolation());

      await expect(
        service.create(PRODUCT_ID, buildCreateDto()),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('P2002 resolved by target array → 409', async () => {
      variantRepoCreateDefault.mockRejectedValue(
        buildUniqueViolation('P2002', { target: ['sku'] }),
      );

      await expect(
        service.create(PRODUCT_ID, buildCreateDto()),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('P2002 on an unrelated model propagates', async () => {
      const failure = buildUniqueViolation('P2002', {
        modelName: 'SomethingElse',
      });
      variantRepoCreateDefault.mockRejectedValue(failure);

      await expect(service.create(PRODUCT_ID, buildCreateDto())).rejects.toBe(
        failure,
      );
    });

    it('a non-P2002 Prisma error propagates untouched', async () => {
      const failure = new Prisma.PrismaClientKnownRequestError('boom', {
        code: 'P2003',
        clientVersion: '7.10.0',
        meta: { modelName: 'ProductVariant' },
      });
      variantRepoCreateDefault.mockRejectedValue(failure);

      await expect(service.create(PRODUCT_ID, buildCreateDto())).rejects.toBe(
        failure,
      );
    });

    it('never forwards database-owned or client-supplied identity fields', async () => {
      const dto = buildCreateDto() as CreateProductVariantDto & {
        id?: string;
        productId?: string;
        createdAt?: Date;
        updatedAt?: Date;
      };
      dto.id = 'attacker';
      dto.productId = 'other-product';
      dto.createdAt = new Date();
      dto.updatedAt = new Date();

      await service.create(PRODUCT_ID, dto);

      const payload = variantRepoCreateDefault.mock.calls[0][0];
      expect(payload.productId).toBe(PRODUCT_ID);
      expect(payload).not.toHaveProperty('id');
      expect(payload).not.toHaveProperty('createdAt');
      expect(payload).not.toHaveProperty('updatedAt');
    });
  });

  describe('read', () => {
    it('findAllByProductId returns the list', async () => {
      productRepoFindById.mockResolvedValue(buildProduct());
      variantRepoFindAll.mockResolvedValue([buildVariant()]);

      const result = await service.findAllByProductId(PRODUCT_ID);

      expect(variantRepoFindAll).toHaveBeenCalledWith(PRODUCT_ID);
      expect(result).toHaveLength(1);
      expect(result[0].sku).toBe('TSHIRT-BLK-M');
    });

    it('findAllByProductId missing product → 404', async () => {
      productRepoFindById.mockResolvedValue(null);

      await expect(
        service.findAllByProductId(PRODUCT_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(variantRepoFindAll).not.toHaveBeenCalled();
    });

    it('findOne returns an owned variant', async () => {
      variantRepoFindByIdAndProductId.mockResolvedValue(buildVariant());

      const result = await service.findOne(PRODUCT_ID, VARIANT_ID);

      expect(variantRepoFindByIdAndProductId).toHaveBeenCalledWith(
        VARIANT_ID,
        PRODUCT_ID,
      );
      expect(result.id).toBe(VARIANT_ID);
    });

    it('findOne variant of another product → 404', async () => {
      variantRepoFindByIdAndProductId.mockResolvedValue(null);

      await expect(
        service.findOne(PRODUCT_ID, VARIANT_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('update', () => {
    beforeEach(() => {
      variantRepoFindBySku.mockResolvedValue(null);
      variantRepoUpdateForProduct.mockImplementation(
        (_productId: string, id: string, data: Record<string, unknown>) =>
          Promise.resolve(buildVariant({ id, ...data })),
      );
    });

    it('updates sku and normalizes it', async () => {
      await service.update(
        PRODUCT_ID,
        VARIANT_ID,
        buildUpdateDto({ sku: '  ab-9  ' }),
      );
      expect(variantRepoUpdateForProduct.mock.calls[0][2].sku).toBe('AB-9');
    });

    it('updates price and normalizes it', async () => {
      await service.update(
        PRODUCT_ID,
        VARIANT_ID,
        buildUpdateDto({ price: '5.5' }),
      );
      expect(variantRepoUpdateForProduct.mock.calls[0][2].price).toBe('5.50');
    });

    it('updates isActive', async () => {
      await service.update(
        PRODUCT_ID,
        VARIANT_ID,
        buildUpdateDto({ isActive: false }),
      );
      expect(variantRepoUpdateForProduct.mock.calls[0][2].isActive).toBe(false);
    });

    it('allows keeping the variant’s own sku', async () => {
      variantRepoFindBySku.mockResolvedValue(buildVariant());

      await expect(
        service.update(
          PRODUCT_ID,
          VARIANT_ID,
          buildUpdateDto({ sku: 'TSHIRT-BLK-M' }),
        ),
      ).resolves.toBeDefined();
      expect(variantRepoUpdateForProduct).toHaveBeenCalledTimes(1);
    });

    it('duplicate sku → 409 and nothing is written', async () => {
      variantRepoFindBySku.mockResolvedValue(buildVariant({ id: 'v-2' }));

      await expect(
        service.update(
          PRODUCT_ID,
          VARIANT_ID,
          buildUpdateDto({ sku: 'AB-9' }),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(variantRepoUpdateForProduct).not.toHaveBeenCalled();
    });

    it('missing or non-owned variant → 404 and nothing is written', async () => {
      variantRepoUpdateForProduct.mockResolvedValue(null);

      await expect(
        service.update(PRODUCT_ID, VARIANT_ID, buildUpdateDto({ price: '1.00' })),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(variantRepoUpdateForProduct).toHaveBeenCalledWith(
        PRODUCT_ID,
        VARIANT_ID,
        { price: '1.00' },
      );
    });

    it('maps Prisma P2002 on the sku → 409', async () => {
      variantRepoUpdateForProduct.mockRejectedValue(buildUniqueViolation());

      await expect(
        service.update(
          PRODUCT_ID,
          VARIANT_ID,
          buildUpdateDto({ sku: 'AB-9' }),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('never forwards productId present on the dto', async () => {
      const dto = buildUpdateDto({ price: '1.00' }) as UpdateProductVariantDto & {
        productId?: string;
      };
      dto.productId = 'other-product';

      await service.update(PRODUCT_ID, VARIANT_ID, dto);

      expect(variantRepoUpdateForProduct.mock.calls[0][2]).not.toHaveProperty(
        'productId',
      );
    });
  });

  describe('cost management', () => {
    it('normalizes and records an admin cost update through the transactional repository', async () => {
      variantRepoUpdateCostForProduct.mockResolvedValue(
        buildVariant({
          costPrice: new Prisma.Decimal('12.50'),
          costCurrency: 'USD',
          costEffectiveAt: new Date('2026-11-09T00:00:00.000Z'),
        }),
      );
      const dto = Object.assign(new UpdateVariantCostDto(), {
        costPrice: '12.5',
        costCurrency: ' usd ',
      });

      const result = await service.updateCost(
        PRODUCT_ID,
        VARIANT_ID,
        dto,
        'a3b2c3d4-e5f6-4f70-8a9b-0c1d2e3f4a5b',
      );

      expect(variantRepoUpdateCostForProduct).toHaveBeenCalledWith(
        PRODUCT_ID,
        VARIANT_ID,
        {
          costPrice: '12.50',
          costCurrency: 'USD',
          changedById: 'a3b2c3d4-e5f6-4f70-8a9b-0c1d2e3f4a5b',
        },
      );
      expect(result.costPrice).toBe('12.50');
      expect(result.costCurrency).toBe('USD');
    });

    it('returns 404 when the addressed variant is absent or belongs to another product', async () => {
      variantRepoUpdateCostForProduct.mockResolvedValue(null);
      const dto = Object.assign(new UpdateVariantCostDto(), {
        costPrice: '12.50',
        costCurrency: 'USD',
      });

      await expect(
        service.updateCost(PRODUCT_ID, VARIANT_ID, dto, PRODUCT_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('retire', () => {
    it('deactivates an owned variant instead of deleting its inventory and references', async () => {
      variantRepoUpdateForProduct.mockResolvedValue(
        buildVariant({ isActive: false }),
      );

      await expect(
        service.remove(PRODUCT_ID, VARIANT_ID),
      ).resolves.toBeUndefined();
      expect(variantRepoUpdateForProduct).toHaveBeenCalledWith(
        PRODUCT_ID,
        VARIANT_ID,
        { isActive: false },
      );
      expect(variantRepoDelete).not.toHaveBeenCalled();
    });

    it('missing or non-owned variant → 404 and nothing is changed', async () => {
      variantRepoUpdateForProduct.mockResolvedValue(null);

      await expect(
        service.remove(PRODUCT_ID, VARIANT_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(variantRepoDelete).not.toHaveBeenCalled();
      expect(variantRepoUpdateForProduct).toHaveBeenCalledWith(
        PRODUCT_ID,
        VARIANT_ID,
        { isActive: false },
      );
    });
  });
});
