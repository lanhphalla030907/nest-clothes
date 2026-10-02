import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '../generated/prisma/client.js';
import { ProductVariantsRepository } from '../product-variants/repositories/product-variants.repository.js';
import { ProductsRepository } from '../products/repositories/products.repository.js';
import { CreateVariantOptionDto } from './dto/create-variant-option.dto.js';
import { UpdateVariantOptionDto } from './dto/update-variant-option.dto.js';
import { VariantOptionsService } from './variant-options.service.js';
import { VariantOptionsRepository } from './repositories/variant-options.repository.js';

const PRODUCT_ID = 'a1b2c3d4-e5f6-4f70-8a9b-0c1d2e3f4a5b';
const VARIANT_ID = 'b2c3d4e5-f6a0-4a1b-9c2d-3e4f5a6b7c8d';
const OPTION_ID = 'c3d4e5f6-a7b8-4c2d-8e3f-4a5b6c7d8e9f';

const buildCreateDto = (
  overrides: Partial<CreateVariantOptionDto> = {},
): CreateVariantOptionDto =>
  Object.assign(new CreateVariantOptionDto(), {
    optionName: '  Color  ',
    optionValue: '  Black  ',
    ...overrides,
  });

const buildUpdateDto = (
  overrides: Partial<UpdateVariantOptionDto> = {},
): UpdateVariantOptionDto =>
  Object.assign(new UpdateVariantOptionDto(), overrides);

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

const buildOption = (overrides: Record<string, unknown> = {}) => ({
  id: OPTION_ID,
  variantId: VARIANT_ID,
  optionName: 'Color',
  optionValue: 'Black',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

const buildUniqueViolation = (code = 'P2002', meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code,
    clientVersion: '7.10.0',
    meta: {
      modelName: 'VariantOption',
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          originalCode: '23505',
          kind: 'UniqueConstraintViolation',
          constraint: { index: 'variant_options_variant_id_option_name_ci_key' },
          table: 'variant_options',
        },
      },
      ...meta,
    },
  });

describe('VariantOptionsService', () => {
  let service: VariantOptionsService;
  let optionRepoCreate: ReturnType<typeof vi.fn>;
  let optionRepoFindAll: ReturnType<typeof vi.fn>;
  let optionRepoFindByIdAndVariantId: ReturnType<typeof vi.fn>;
  let optionRepoFindByName: ReturnType<typeof vi.fn>;
  let optionRepoUpdate: ReturnType<typeof vi.fn>;
  let optionRepoDelete: ReturnType<typeof vi.fn>;
  let variantRepoFindByIdAndProductId: ReturnType<typeof vi.fn>;
  let productRepoFindById: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    optionRepoCreate = vi.fn();
    optionRepoFindAll = vi.fn();
    optionRepoFindByIdAndVariantId = vi.fn();
    optionRepoFindByName = vi.fn();
    optionRepoUpdate = vi.fn();
    optionRepoDelete = vi.fn();
    variantRepoFindByIdAndProductId = vi.fn();
    productRepoFindById = vi.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VariantOptionsService,
        {
          provide: VariantOptionsRepository,
          useValue: {
            create: optionRepoCreate,
            findAllByVariantId: optionRepoFindAll,
            findByIdAndVariantId: optionRepoFindByIdAndVariantId,
            findByVariantIdAndOptionName: optionRepoFindByName,
            update: optionRepoUpdate,
            delete: optionRepoDelete,
          },
        },
        {
          provide: ProductVariantsRepository,
          useValue: {
            findByIdAndProductId: variantRepoFindByIdAndProductId,
          },
        },
        {
          provide: ProductsRepository,
          useValue: { findById: productRepoFindById },
        },
      ],
    }).compile();

    service = module.get<VariantOptionsService>(VariantOptionsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    beforeEach(() => {
      productRepoFindById.mockResolvedValue(buildProduct());
      variantRepoFindByIdAndProductId.mockResolvedValue(buildVariant());
      optionRepoFindByName.mockResolvedValue(null);
      optionRepoCreate.mockImplementation((data: Record<string, unknown>) =>
        Promise.resolve(buildOption(data)),
      );
    });

    it('creates a valid option with the variant id from the path', async () => {
      const result = await service.create(
        PRODUCT_ID,
        VARIANT_ID,
        buildCreateDto(),
      );

      expect(variantRepoFindByIdAndProductId).toHaveBeenCalledWith(
        VARIANT_ID,
        PRODUCT_ID,
      );
      expect(optionRepoCreate).toHaveBeenCalledTimes(1);
      expect(optionRepoCreate.mock.calls[0][0]).toMatchObject({
        variantId: VARIANT_ID,
        optionName: 'Color',
        optionValue: 'Black',
      });
      expect(result).toMatchObject({
        id: OPTION_ID,
        variantId: VARIANT_ID,
        optionName: 'Color',
        optionValue: 'Black',
      });
    });

    it('normalizes the option name by trimming and collapsing whitespace', async () => {
      await service.create(
        PRODUCT_ID,
        VARIANT_ID,
        buildCreateDto({ optionName: '  Colour   Name  ' }),
      );
      expect(optionRepoCreate.mock.calls[0][0].optionName).toBe('Colour Name');
    });

    it('normalizes the option value by trimming and collapsing whitespace', async () => {
      await service.create(
        PRODUCT_ID,
        VARIANT_ID,
        buildCreateDto({ optionValue: '  Extra   Large  ' }),
      );
      expect(optionRepoCreate.mock.calls[0][0].optionValue).toBe('Extra Large');
    });

    it('preserves the case of the stored option name', async () => {
      await service.create(
        PRODUCT_ID,
        VARIANT_ID,
        buildCreateDto({ optionName: 'Color' }),
      );
      expect(optionRepoCreate.mock.calls[0][0].optionName).toBe('Color');
    });

    it('missing product → 404 and nothing is written', async () => {
      productRepoFindById.mockResolvedValue(null);

      await expect(
        service.create(PRODUCT_ID, VARIANT_ID, buildCreateDto()),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(optionRepoCreate).not.toHaveBeenCalled();
    });

    it('variant of another product → 404 and nothing is written', async () => {
      variantRepoFindByIdAndProductId.mockResolvedValue(null);

      await expect(
        service.create(PRODUCT_ID, VARIANT_ID, buildCreateDto()),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(optionRepoCreate).not.toHaveBeenCalled();
    });

    it('duplicate option name → 409 before writing', async () => {
      optionRepoFindByName.mockResolvedValue(buildOption({ id: 'o-2' }));

      await expect(
        service.create(PRODUCT_ID, VARIANT_ID, buildCreateDto()),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(optionRepoCreate).not.toHaveBeenCalled();
    });

    it('case-insensitive duplicate is checked with the normalized name', async () => {
      await service.create(
        PRODUCT_ID,
        VARIANT_ID,
        buildCreateDto({ optionName: '  color  ' }),
      );
      expect(optionRepoFindByName).toHaveBeenCalledWith(VARIANT_ID, 'color');
    });

    it('maps Prisma P2002 on the option name → 409', async () => {
      optionRepoCreate.mockRejectedValue(buildUniqueViolation());

      await expect(
        service.create(PRODUCT_ID, VARIANT_ID, buildCreateDto()),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('P2002 resolved by the compound target array → 409', async () => {
      optionRepoCreate.mockRejectedValue(
        buildUniqueViolation('P2002', { target: ['variantId', 'optionName'] }),
      );

      await expect(
        service.create(PRODUCT_ID, VARIANT_ID, buildCreateDto()),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('P2002 on an unrelated model propagates', async () => {
      const failure = buildUniqueViolation('P2002', {
        modelName: 'SomethingElse',
      });
      optionRepoCreate.mockRejectedValue(failure);

      await expect(
        service.create(PRODUCT_ID, VARIANT_ID, buildCreateDto()),
      ).rejects.toBe(failure);
    });

    it('a non-P2002 Prisma error propagates untouched', async () => {
      const failure = new Prisma.PrismaClientKnownRequestError('boom', {
        code: 'P2003',
        clientVersion: '7.10.0',
        meta: { modelName: 'VariantOption' },
      });
      optionRepoCreate.mockRejectedValue(failure);

      await expect(
        service.create(PRODUCT_ID, VARIANT_ID, buildCreateDto()),
      ).rejects.toBe(failure);
    });

    it('never forwards database-owned or client-supplied identity fields', async () => {
      const dto = buildCreateDto() as CreateVariantOptionDto & {
        id?: string;
        variantId?: string;
        createdAt?: Date;
        updatedAt?: Date;
      };
      dto.id = 'attacker';
      dto.variantId = 'other-variant';
      dto.createdAt = new Date();
      dto.updatedAt = new Date();

      await service.create(PRODUCT_ID, VARIANT_ID, dto);

      const payload = optionRepoCreate.mock.calls[0][0];
      expect(payload.variantId).toBe(VARIANT_ID);
      expect(payload).not.toHaveProperty('id');
      expect(payload).not.toHaveProperty('createdAt');
      expect(payload).not.toHaveProperty('updatedAt');
    });
  });

  describe('read', () => {
    beforeEach(() => {
      productRepoFindById.mockResolvedValue(buildProduct());
      variantRepoFindByIdAndProductId.mockResolvedValue(buildVariant());
    });

    it('findAllByVariantId returns the list', async () => {
      optionRepoFindAll.mockResolvedValue([buildOption()]);

      const result = await service.findAllByVariantId(PRODUCT_ID, VARIANT_ID);

      expect(optionRepoFindAll).toHaveBeenCalledWith(VARIANT_ID);
      expect(result).toHaveLength(1);
      expect(result[0].optionName).toBe('Color');
    });

    it('findAllByVariantId missing product → 404', async () => {
      productRepoFindById.mockResolvedValue(null);

      await expect(
        service.findAllByVariantId(PRODUCT_ID, VARIANT_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(optionRepoFindAll).not.toHaveBeenCalled();
    });

    it('findAllByVariantId variant of another product → 404', async () => {
      variantRepoFindByIdAndProductId.mockResolvedValue(null);

      await expect(
        service.findAllByVariantId(PRODUCT_ID, VARIANT_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(optionRepoFindAll).not.toHaveBeenCalled();
    });

    it('findOne returns an owned option', async () => {
      optionRepoFindByIdAndVariantId.mockResolvedValue(buildOption());

      const result = await service.findOne(PRODUCT_ID, VARIANT_ID, OPTION_ID);

      expect(optionRepoFindByIdAndVariantId).toHaveBeenCalledWith(
        OPTION_ID,
        VARIANT_ID,
      );
      expect(result.id).toBe(OPTION_ID);
    });

    it('findOne option of another variant → 404', async () => {
      optionRepoFindByIdAndVariantId.mockResolvedValue(null);

      await expect(
        service.findOne(PRODUCT_ID, VARIANT_ID, OPTION_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('findOne missing variant → 404 before the option lookup', async () => {
      variantRepoFindByIdAndProductId.mockResolvedValue(null);

      await expect(
        service.findOne(PRODUCT_ID, VARIANT_ID, OPTION_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(optionRepoFindByIdAndVariantId).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    beforeEach(() => {
      productRepoFindById.mockResolvedValue(buildProduct());
      variantRepoFindByIdAndProductId.mockResolvedValue(buildVariant());
      optionRepoFindByIdAndVariantId.mockResolvedValue(buildOption());
      optionRepoFindByName.mockResolvedValue(null);
      optionRepoUpdate.mockImplementation(
        (id: string, data: Record<string, unknown>) =>
          Promise.resolve(buildOption({ id, ...data })),
      );
    });

    it('updates the option name and normalizes it', async () => {
      await service.update(
        PRODUCT_ID,
        VARIANT_ID,
        OPTION_ID,
        buildUpdateDto({ optionName: '  Material  ' }),
      );
      expect(optionRepoUpdate.mock.calls[0][1].optionName).toBe('Material');
    });

    it('updates the option value and normalizes it', async () => {
      await service.update(
        PRODUCT_ID,
        VARIANT_ID,
        OPTION_ID,
        buildUpdateDto({ optionValue: '  Extra   Large ' }),
      );
      expect(optionRepoUpdate.mock.calls[0][1].optionValue).toBe('Extra Large');
    });

    it('allows keeping the option’s own name', async () => {
      optionRepoFindByName.mockResolvedValue(buildOption());

      await expect(
        service.update(
          PRODUCT_ID,
          VARIANT_ID,
          OPTION_ID,
          buildUpdateDto({ optionName: 'Color' }),
        ),
      ).resolves.toBeDefined();
      expect(optionRepoUpdate).toHaveBeenCalledTimes(1);
    });

    it('duplicate option name → 409 and nothing is written', async () => {
      optionRepoFindByName.mockResolvedValue(buildOption({ id: 'o-2' }));

      await expect(
        service.update(
          PRODUCT_ID,
          VARIANT_ID,
          OPTION_ID,
          buildUpdateDto({ optionName: 'Material' }),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(optionRepoUpdate).not.toHaveBeenCalled();
    });

    it('missing or non-owned option → 404 and nothing is written', async () => {
      optionRepoFindByIdAndVariantId.mockResolvedValue(null);

      await expect(
        service.update(
          PRODUCT_ID,
          VARIANT_ID,
          OPTION_ID,
          buildUpdateDto({ optionValue: 'White' }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(optionRepoUpdate).not.toHaveBeenCalled();
    });

    it('maps Prisma P2002 on the option name → 409', async () => {
      optionRepoUpdate.mockRejectedValue(buildUniqueViolation());

      await expect(
        service.update(
          PRODUCT_ID,
          VARIANT_ID,
          OPTION_ID,
          buildUpdateDto({ optionName: 'Material' }),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('never forwards variantId present on the dto', async () => {
      const dto = buildUpdateDto({ optionValue: 'White' }) as UpdateVariantOptionDto & {
        variantId?: string;
      };
      dto.variantId = 'other-variant';

      await service.update(PRODUCT_ID, VARIANT_ID, OPTION_ID, dto);

      expect(optionRepoUpdate.mock.calls[0][1]).not.toHaveProperty('variantId');
    });
  });

  describe('delete', () => {
    beforeEach(() => {
      productRepoFindById.mockResolvedValue(buildProduct());
      variantRepoFindByIdAndProductId.mockResolvedValue(buildVariant());
      optionRepoFindByIdAndVariantId.mockResolvedValue(buildOption());
      optionRepoDelete.mockResolvedValue(buildOption());
    });

    it('deletes an owned option', async () => {
      await expect(
        service.remove(PRODUCT_ID, VARIANT_ID, OPTION_ID),
      ).resolves.toBeUndefined();
      expect(optionRepoDelete).toHaveBeenCalledWith(OPTION_ID);
    });

    it('missing or non-owned option → 404 and nothing is deleted', async () => {
      optionRepoFindByIdAndVariantId.mockResolvedValue(null);

      await expect(
        service.remove(PRODUCT_ID, VARIANT_ID, OPTION_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(optionRepoDelete).not.toHaveBeenCalled();
    });
  });
});
