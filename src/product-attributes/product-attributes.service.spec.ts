import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '../generated/prisma/client.js';
import { ProductsRepository } from '../products/repositories/products.repository.js';
import { CreateProductAttributeDto } from './dto/create-product-attribute.dto.js';
import { UpdateProductAttributeDto } from './dto/update-product-attribute.dto.js';
import { ProductAttributesService } from './product-attributes.service.js';
import { ProductAttributesRepository } from './repositories/product-attributes.repository.js';

const PRODUCT_ID = 'a1b2c3d4-e5f6-4f70-8a9b-0c1d2e3f4a5b';
const ATTRIBUTE_ID = 'c3d4e5f6-a7b8-4c2d-8e3f-4a5b6c7d8e9f';

const buildCreateDto = (
  overrides: Partial<CreateProductAttributeDto> = {},
): CreateProductAttributeDto =>
  Object.assign(new CreateProductAttributeDto(), {
    attributeName: '  Material  ',
    attributeValue: '  Cotton  ',
    ...overrides,
  });

const buildUpdateDto = (
  overrides: Partial<UpdateProductAttributeDto> = {},
): UpdateProductAttributeDto =>
  Object.assign(new UpdateProductAttributeDto(), overrides);

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

const buildAttribute = (overrides: Record<string, unknown> = {}) => ({
  id: ATTRIBUTE_ID,
  productId: PRODUCT_ID,
  attributeName: 'Material',
  attributeValue: 'Cotton',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

const buildUniqueViolation = (
  code = 'P2002',
  meta?: Record<string, unknown>,
) =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code,
    clientVersion: '7.10.0',
    meta: {
      modelName: 'ProductAttribute',
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          originalCode: '23505',
          kind: 'UniqueConstraintViolation',
          constraint: {
            index: 'product_attributes_product_id_attribute_name_ci_key',
          },
          table: 'product_attributes',
        },
      },
      ...meta,
    },
  });

describe('ProductAttributesService', () => {
  let service: ProductAttributesService;
  let attributeRepoCreate: ReturnType<typeof vi.fn>;
  let attributeRepoFindAll: ReturnType<typeof vi.fn>;
  let attributeRepoFindByIdAndProductId: ReturnType<typeof vi.fn>;
  let attributeRepoFindByName: ReturnType<typeof vi.fn>;
  let attributeRepoUpdate: ReturnType<typeof vi.fn>;
  let attributeRepoDelete: ReturnType<typeof vi.fn>;
  let productRepoFindById: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    attributeRepoCreate = vi.fn();
    attributeRepoFindAll = vi.fn();
    attributeRepoFindByIdAndProductId = vi.fn();
    attributeRepoFindByName = vi.fn();
    attributeRepoUpdate = vi.fn();
    attributeRepoDelete = vi.fn();
    productRepoFindById = vi.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductAttributesService,
        {
          provide: ProductAttributesRepository,
          useValue: {
            create: attributeRepoCreate,
            findAllByProductId: attributeRepoFindAll,
            findByIdAndProductId: attributeRepoFindByIdAndProductId,
            findByProductIdAndAttributeName: attributeRepoFindByName,
            update: attributeRepoUpdate,
            delete: attributeRepoDelete,
          },
        },
        {
          provide: ProductsRepository,
          useValue: { findById: productRepoFindById },
        },
      ],
    }).compile();

    service = module.get<ProductAttributesService>(ProductAttributesService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    beforeEach(() => {
      productRepoFindById.mockResolvedValue(buildProduct());
      attributeRepoFindByName.mockResolvedValue(null);
      attributeRepoCreate.mockImplementation((data: Record<string, unknown>) =>
        Promise.resolve(buildAttribute(data)),
      );
    });

    it('creates a valid attribute with the product id from the path', async () => {
      const result = await service.create(PRODUCT_ID, buildCreateDto());

      expect(attributeRepoCreate).toHaveBeenCalledTimes(1);
      expect(attributeRepoCreate.mock.calls[0][0]).toMatchObject({
        productId: PRODUCT_ID,
        attributeName: 'Material',
        attributeValue: 'Cotton',
      });
      expect(result).toMatchObject({
        id: ATTRIBUTE_ID,
        productId: PRODUCT_ID,
        attributeName: 'Material',
        attributeValue: 'Cotton',
      });
    });

    it('normalizes the attribute name by trimming and collapsing whitespace', async () => {
      await service.create(
        PRODUCT_ID,
        buildCreateDto({ attributeName: '  Care   Instruction  ' }),
      );
      expect(attributeRepoCreate.mock.calls[0][0].attributeName).toBe(
        'Care Instruction',
      );
    });

    it('normalizes the attribute value by trimming and collapsing whitespace', async () => {
      await service.create(
        PRODUCT_ID,
        buildCreateDto({ attributeValue: '  Machine   Wash  ' }),
      );
      expect(attributeRepoCreate.mock.calls[0][0].attributeValue).toBe(
        'Machine Wash',
      );
    });

    it('preserves the case of the stored attribute name', async () => {
      await service.create(
        PRODUCT_ID,
        buildCreateDto({ attributeName: 'Material' }),
      );
      expect(attributeRepoCreate.mock.calls[0][0].attributeName).toBe(
        'Material',
      );
    });

    it('missing product → 404 and nothing is written', async () => {
      productRepoFindById.mockResolvedValue(null);

      await expect(
        service.create(PRODUCT_ID, buildCreateDto()),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(attributeRepoCreate).not.toHaveBeenCalled();
    });

    it('duplicate attribute name → 409 before writing', async () => {
      attributeRepoFindByName.mockResolvedValue(buildAttribute({ id: 'a-2' }));

      await expect(
        service.create(PRODUCT_ID, buildCreateDto()),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(attributeRepoCreate).not.toHaveBeenCalled();
    });

    it('case-insensitive duplicate is checked with the normalized name', async () => {
      await service.create(
        PRODUCT_ID,
        buildCreateDto({ attributeName: '  material  ' }),
      );
      expect(attributeRepoFindByName).toHaveBeenCalledWith(
        PRODUCT_ID,
        'material',
      );
    });

    it('maps Prisma P2002 on the attribute name → 409', async () => {
      attributeRepoCreate.mockRejectedValue(buildUniqueViolation());

      await expect(
        service.create(PRODUCT_ID, buildCreateDto()),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('P2002 resolved by the compound target array → 409', async () => {
      attributeRepoCreate.mockRejectedValue(
        buildUniqueViolation('P2002', {
          target: ['productId', 'attributeName'],
        }),
      );

      await expect(
        service.create(PRODUCT_ID, buildCreateDto()),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('P2002 on an unrelated model propagates', async () => {
      const failure = buildUniqueViolation('P2002', {
        modelName: 'SomethingElse',
      });
      attributeRepoCreate.mockRejectedValue(failure);

      await expect(
        service.create(PRODUCT_ID, buildCreateDto()),
      ).rejects.toBe(failure);
    });

    it('a non-P2002 Prisma error propagates untouched', async () => {
      const failure = new Prisma.PrismaClientKnownRequestError('boom', {
        code: 'P2003',
        clientVersion: '7.10.0',
        meta: { modelName: 'ProductAttribute' },
      });
      attributeRepoCreate.mockRejectedValue(failure);

      await expect(
        service.create(PRODUCT_ID, buildCreateDto()),
      ).rejects.toBe(failure);
    });

    it('never forwards database-owned or client-supplied identity fields', async () => {
      const dto = buildCreateDto() as CreateProductAttributeDto & {
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

      const payload = attributeRepoCreate.mock.calls[0][0];
      expect(payload.productId).toBe(PRODUCT_ID);
      expect(payload).not.toHaveProperty('id');
      expect(payload).not.toHaveProperty('createdAt');
      expect(payload).not.toHaveProperty('updatedAt');
    });
  });

  describe('read', () => {
    beforeEach(() => {
      productRepoFindById.mockResolvedValue(buildProduct());
    });

    it('findAllByProductId returns the list', async () => {
      attributeRepoFindAll.mockResolvedValue([buildAttribute()]);

      const result = await service.findAllByProductId(PRODUCT_ID);

      expect(attributeRepoFindAll).toHaveBeenCalledWith(PRODUCT_ID);
      expect(result).toHaveLength(1);
      expect(result[0].attributeName).toBe('Material');
    });

    it('findAllByProductId missing product → 404', async () => {
      productRepoFindById.mockResolvedValue(null);

      await expect(
        service.findAllByProductId(PRODUCT_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(attributeRepoFindAll).not.toHaveBeenCalled();
    });

    it('findOne returns an owned attribute', async () => {
      attributeRepoFindByIdAndProductId.mockResolvedValue(buildAttribute());

      const result = await service.findOne(PRODUCT_ID, ATTRIBUTE_ID);

      expect(attributeRepoFindByIdAndProductId).toHaveBeenCalledWith(
        ATTRIBUTE_ID,
        PRODUCT_ID,
      );
      expect(result.id).toBe(ATTRIBUTE_ID);
    });

    it('findOne attribute of another product → 404', async () => {
      attributeRepoFindByIdAndProductId.mockResolvedValue(null);

      await expect(
        service.findOne(PRODUCT_ID, ATTRIBUTE_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('findOne missing product → 404 before the attribute lookup', async () => {
      productRepoFindById.mockResolvedValue(null);

      await expect(
        service.findOne(PRODUCT_ID, ATTRIBUTE_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(attributeRepoFindByIdAndProductId).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    beforeEach(() => {
      productRepoFindById.mockResolvedValue(buildProduct());
      attributeRepoFindByIdAndProductId.mockResolvedValue(buildAttribute());
      attributeRepoFindByName.mockResolvedValue(null);
      attributeRepoUpdate.mockImplementation(
        (id: string, data: Record<string, unknown>) =>
          Promise.resolve(buildAttribute({ id, ...data })),
      );
    });

    it('updates the attribute name and normalizes it', async () => {
      await service.update(
        PRODUCT_ID,
        ATTRIBUTE_ID,
        buildUpdateDto({ attributeName: '  Fit  ' }),
      );
      expect(attributeRepoUpdate.mock.calls[0][1].attributeName).toBe('Fit');
    });

    it('updates the attribute value and normalizes it', async () => {
      await service.update(
        PRODUCT_ID,
        ATTRIBUTE_ID,
        buildUpdateDto({ attributeValue: '  Extra   Large ' }),
      );
      expect(attributeRepoUpdate.mock.calls[0][1].attributeValue).toBe(
        'Extra Large',
      );
    });

    it('allows keeping the attribute’s own name', async () => {
      attributeRepoFindByName.mockResolvedValue(buildAttribute());

      await expect(
        service.update(
          PRODUCT_ID,
          ATTRIBUTE_ID,
          buildUpdateDto({ attributeName: 'Material' }),
        ),
      ).resolves.toBeDefined();
      expect(attributeRepoUpdate).toHaveBeenCalledTimes(1);
    });

    it('duplicate attribute name → 409 and nothing is written', async () => {
      attributeRepoFindByName.mockResolvedValue(buildAttribute({ id: 'a-2' }));

      await expect(
        service.update(
          PRODUCT_ID,
          ATTRIBUTE_ID,
          buildUpdateDto({ attributeName: 'Fit' }),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(attributeRepoUpdate).not.toHaveBeenCalled();
    });

    it('missing or non-owned attribute → 404 and nothing is written', async () => {
      attributeRepoFindByIdAndProductId.mockResolvedValue(null);

      await expect(
        service.update(
          PRODUCT_ID,
          ATTRIBUTE_ID,
          buildUpdateDto({ attributeValue: 'Linen' }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(attributeRepoUpdate).not.toHaveBeenCalled();
    });

    it('maps Prisma P2002 on the attribute name → 409', async () => {
      attributeRepoUpdate.mockRejectedValue(buildUniqueViolation());

      await expect(
        service.update(
          PRODUCT_ID,
          ATTRIBUTE_ID,
          buildUpdateDto({ attributeName: 'Fit' }),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('never forwards productId present on the dto', async () => {
      const dto = buildUpdateDto({
        attributeValue: 'Linen',
      }) as UpdateProductAttributeDto & { productId?: string };
      dto.productId = 'other-product';

      await service.update(PRODUCT_ID, ATTRIBUTE_ID, dto);

      expect(attributeRepoUpdate.mock.calls[0][1]).not.toHaveProperty(
        'productId',
      );
    });
  });

  describe('delete', () => {
    beforeEach(() => {
      productRepoFindById.mockResolvedValue(buildProduct());
      attributeRepoFindByIdAndProductId.mockResolvedValue(buildAttribute());
      attributeRepoDelete.mockResolvedValue(buildAttribute());
    });

    it('deletes an owned attribute', async () => {
      await expect(
        service.remove(PRODUCT_ID, ATTRIBUTE_ID),
      ).resolves.toBeUndefined();
      expect(attributeRepoDelete).toHaveBeenCalledWith(ATTRIBUTE_ID);
    });

    it('missing or non-owned attribute → 404 and nothing is deleted', async () => {
      attributeRepoFindByIdAndProductId.mockResolvedValue(null);

      await expect(
        service.remove(PRODUCT_ID, ATTRIBUTE_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(attributeRepoDelete).not.toHaveBeenCalled();
    });
  });
});
