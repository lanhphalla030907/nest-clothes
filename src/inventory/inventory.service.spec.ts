import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '../generated/prisma/client.js';
import { ProductVariantsRepository } from '../product-variants/repositories/product-variants.repository.js';
import { ProductsRepository } from '../products/repositories/products.repository.js';
import { CreateInventoryDto } from './dto/create-inventory.dto.js';
import { UpdateInventoryDto } from './dto/update-inventory.dto.js';
import { InventoryService } from './inventory.service.js';
import { InventoryRepository } from './repositories/inventory.repository.js';

const PRODUCT_ID = 'a1b2c3d4-e5f6-4f70-8a9b-0c1d2e3f4a5b';
const VARIANT_ID = 'b2c3d4e5-f6a0-4a1b-9c2d-3e4f5a6b7c8d';

const buildCreateDto = (
  overrides: Partial<CreateInventoryDto> = {},
): CreateInventoryDto =>
  Object.assign(new CreateInventoryDto(), overrides);

const buildUpdateDto = (
  overrides: Partial<UpdateInventoryDto> = {},
): UpdateInventoryDto =>
  Object.assign(new UpdateInventoryDto(), overrides);

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

const buildInventory = (overrides: Record<string, unknown> = {}) => ({
  id: 'i-1',
  variantId: VARIANT_ID,
  quantity: 10,
  reservedQuantity: 2,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

const buildUniqueViolation = (meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '7.10.0',
    meta: {
      modelName: 'Inventory',
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          originalCode: '23505',
          kind: 'UniqueConstraintViolation',
          constraint: { index: 'inventory_variant_id_key' },
          table: 'inventory',
        },
      },
      ...meta,
    },
  });

const buildCheckViolation = () =>
  new Prisma.PrismaClientKnownRequestError('Check constraint failed', {
    code: 'P2004',
    clientVersion: '7.10.0',
    meta: {
      modelName: 'Inventory',
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          originalCode: '23514',
          kind: 'CheckConstraintViolation',
          constraint: {
            index: 'inventory_reserved_not_above_quantity',
          },
          table: 'inventory',
        },
      },
    },
  });

describe('InventoryService', () => {
  let service: InventoryService;
  let inventoryRepoCreate: ReturnType<typeof vi.fn>;
  let inventoryRepoFindByVariantId: ReturnType<typeof vi.fn>;
  let inventoryRepoUpdate: ReturnType<typeof vi.fn>;
  let inventoryRepoRunInTransaction: ReturnType<typeof vi.fn>;
  let variantRepoFindByIdAndProductId: ReturnType<typeof vi.fn>;
  let productRepoFindById: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    inventoryRepoCreate = vi.fn();
    inventoryRepoFindByVariantId = vi.fn();
    inventoryRepoUpdate = vi.fn();
    inventoryRepoRunInTransaction = vi
      .fn()
      .mockImplementation((work: (tx: unknown) => Promise<unknown>) =>
        work({ tx: true }),
      );
    variantRepoFindByIdAndProductId = vi.fn();
    productRepoFindById = vi.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InventoryService,
        {
          provide: InventoryRepository,
          useValue: {
            create: inventoryRepoCreate,
            findByVariantId: inventoryRepoFindByVariantId,
            update: inventoryRepoUpdate,
            runInTransaction: inventoryRepoRunInTransaction,
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

    service = module.get<InventoryService>(InventoryService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    beforeEach(() => {
      productRepoFindById.mockResolvedValue(buildProduct());
      variantRepoFindByIdAndProductId.mockResolvedValue(buildVariant());
      inventoryRepoFindByVariantId.mockResolvedValue(null);
      inventoryRepoCreate.mockImplementation((data: Record<string, unknown>) =>
        Promise.resolve(buildInventory(data)),
      );
    });

    it('creates an inventory row with the variant id from the path', async () => {
      const result = await service.create(PRODUCT_ID, VARIANT_ID, buildCreateDto());

      expect(inventoryRepoCreate).toHaveBeenCalledTimes(1);
      expect(inventoryRepoCreate.mock.calls[0][0]).toMatchObject({
        variantId: VARIANT_ID,
      });
      expect(result.variantId).toBe(VARIANT_ID);
    });

    it('defaults both counters to zero when the body is empty', async () => {
      await service.create(PRODUCT_ID, VARIANT_ID, buildCreateDto());

      expect(inventoryRepoCreate.mock.calls[0][0]).toMatchObject({
        quantity: 0,
        reservedQuantity: 0,
      });
    });

    it('honours supplied counters and computes available', async () => {
      const result = await service.create(
        PRODUCT_ID,
        VARIANT_ID,
        buildCreateDto({ quantity: 10, reservedQuantity: 2 }),
      );

      expect(inventoryRepoCreate.mock.calls[0][0]).toMatchObject({
        quantity: 10,
        reservedQuantity: 2,
      });
      expect(result.available).toBe(8);
    });

    it('available is quantity minus reservedQuantity', async () => {
      inventoryRepoCreate.mockResolvedValue(
        buildInventory({ quantity: 5, reservedQuantity: 5 }),
      );

      const result = await service.create(
        PRODUCT_ID,
        VARIANT_ID,
        buildCreateDto({ quantity: 5, reservedQuantity: 5 }),
      );

      expect(result.available).toBe(0);
    });

    it('missing product → 404 and nothing is written', async () => {
      productRepoFindById.mockResolvedValue(null);

      await expect(
        service.create(PRODUCT_ID, VARIANT_ID, buildCreateDto()),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(inventoryRepoCreate).not.toHaveBeenCalled();
    });

    it('variant of another product → 404 and nothing is written', async () => {
      variantRepoFindByIdAndProductId.mockResolvedValue(null);

      await expect(
        service.create(PRODUCT_ID, VARIANT_ID, buildCreateDto()),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(inventoryRepoCreate).not.toHaveBeenCalled();
    });

    it('negative quantity → 400 and nothing is written', async () => {
      await expect(
        service.create(
          PRODUCT_ID,
          VARIANT_ID,
          buildCreateDto({ quantity: -1 }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(inventoryRepoCreate).not.toHaveBeenCalled();
    });

    it('negative reservedQuantity → 400 and nothing is written', async () => {
      await expect(
        service.create(
          PRODUCT_ID,
          VARIANT_ID,
          buildCreateDto({ reservedQuantity: -1 }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(inventoryRepoCreate).not.toHaveBeenCalled();
    });

    it('reservedQuantity greater than quantity → 400 and nothing is written', async () => {
      await expect(
        service.create(
          PRODUCT_ID,
          VARIANT_ID,
          buildCreateDto({ quantity: 1, reservedQuantity: 2 }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(inventoryRepoCreate).not.toHaveBeenCalled();
    });

    it('duplicate inventory → 409 before writing', async () => {
      inventoryRepoFindByVariantId.mockResolvedValue(buildInventory());

      await expect(
        service.create(PRODUCT_ID, VARIANT_ID, buildCreateDto()),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(inventoryRepoCreate).not.toHaveBeenCalled();
    });

    it('maps Prisma P2002 on variant_id → 409', async () => {
      inventoryRepoCreate.mockRejectedValue(buildUniqueViolation());

      await expect(
        service.create(PRODUCT_ID, VARIANT_ID, buildCreateDto()),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('P2002 resolved by the target array → 409', async () => {
      inventoryRepoCreate.mockRejectedValue(
        buildUniqueViolation({ target: ['variantId'] }),
      );

      await expect(
        service.create(PRODUCT_ID, VARIANT_ID, buildCreateDto()),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('P2002 on an unrelated model propagates', async () => {
      const failure = buildUniqueViolation({ modelName: 'SomethingElse' });
      inventoryRepoCreate.mockRejectedValue(failure);

      await expect(
        service.create(PRODUCT_ID, VARIANT_ID, buildCreateDto()),
      ).rejects.toBe(failure);
    });

    it('translates a database check-constraint violation → 400', async () => {
      inventoryRepoCreate.mockRejectedValue(buildCheckViolation());

      await expect(
        service.create(PRODUCT_ID, VARIANT_ID, buildCreateDto()),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('a non-constraint Prisma error propagates untouched', async () => {
      const failure = new Prisma.PrismaClientKnownRequestError('boom', {
        code: 'P2003',
        clientVersion: '7.10.0',
        meta: { modelName: 'Inventory' },
      });
      inventoryRepoCreate.mockRejectedValue(failure);

      await expect(
        service.create(PRODUCT_ID, VARIANT_ID, buildCreateDto()),
      ).rejects.toBe(failure);
    });

    it('never forwards database-owned or client-supplied identity fields', async () => {
      const dto = buildCreateDto({ quantity: 3 }) as CreateInventoryDto & {
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

      const payload = inventoryRepoCreate.mock.calls[0][0];
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

    it('findOne returns the owned inventory with available computed', async () => {
      inventoryRepoFindByVariantId.mockResolvedValue(buildInventory());

      const result = await service.findOne(PRODUCT_ID, VARIANT_ID);

      expect(inventoryRepoFindByVariantId).toHaveBeenCalledWith(VARIANT_ID);
      expect(result).toMatchObject({
        variantId: VARIANT_ID,
        quantity: 10,
        reservedQuantity: 2,
        available: 8,
      });
    });

    it('findOne missing product → 404', async () => {
      productRepoFindById.mockResolvedValue(null);

      await expect(
        service.findOne(PRODUCT_ID, VARIANT_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('findOne variant of another product → 404', async () => {
      variantRepoFindByIdAndProductId.mockResolvedValue(null);

      await expect(
        service.findOne(PRODUCT_ID, VARIANT_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('findOne with no inventory row → 404', async () => {
      inventoryRepoFindByVariantId.mockResolvedValue(null);

      await expect(
        service.findOne(PRODUCT_ID, VARIANT_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('update', () => {
    beforeEach(() => {
      productRepoFindById.mockResolvedValue(buildProduct());
      variantRepoFindByIdAndProductId.mockResolvedValue(buildVariant());
      inventoryRepoFindByVariantId.mockResolvedValue(buildInventory());
      inventoryRepoUpdate.mockImplementation(
        (variantId: string, data: Record<string, unknown>) =>
          Promise.resolve(buildInventory({ variantId, ...data })),
      );
    });

    it('runs the read-merge-write inside a transaction', async () => {
      await service.update(
        PRODUCT_ID,
        VARIANT_ID,
        buildUpdateDto({ quantity: 7 }),
      );

      expect(inventoryRepoRunInTransaction).toHaveBeenCalledTimes(1);
    });

    it('updates quantity and sends only that counter to the repository', async () => {
      const result = await service.update(
        PRODUCT_ID,
        VARIANT_ID,
        buildUpdateDto({ quantity: 7 }),
      );

      expect(inventoryRepoUpdate).toHaveBeenCalledWith(
        VARIANT_ID,
        { quantity: 7 },
        expect.anything(),
      );
      expect(result.quantity).toBe(7);
      expect(result.reservedQuantity).toBe(2);
      expect(result.available).toBe(5);
    });

    it('updates reservedQuantity and sends only that counter', async () => {
      await service.update(
        PRODUCT_ID,
        VARIANT_ID,
        buildUpdateDto({ reservedQuantity: 4 }),
      );

      expect(inventoryRepoUpdate).toHaveBeenCalledWith(
        VARIANT_ID,
        { reservedQuantity: 4 },
        expect.anything(),
      );
    });

    it('merges the omitted counter from the current row before validating', async () => {
      inventoryRepoFindByVariantId.mockResolvedValue(
        buildInventory({ quantity: 10, reservedQuantity: 2 }),
      );

      await expect(
        service.update(
          PRODUCT_ID,
          VARIANT_ID,
          buildUpdateDto({ reservedQuantity: 10 }),
        ),
      ).resolves.toBeDefined();
      expect(inventoryRepoUpdate).toHaveBeenCalledWith(
        VARIANT_ID,
        { reservedQuantity: 10 },
        expect.anything(),
      );
    });

    it('reservedQuantity greater than quantity → 400 and nothing is written', async () => {
      inventoryRepoFindByVariantId.mockResolvedValue(
        buildInventory({ quantity: 10, reservedQuantity: 2 }),
      );

      await expect(
        service.update(
          PRODUCT_ID,
          VARIANT_ID,
          buildUpdateDto({ quantity: 4, reservedQuantity: 5 }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(inventoryRepoUpdate).not.toHaveBeenCalled();
    });

    it('negative counter → 400 and nothing is written', async () => {
      await expect(
        service.update(
          PRODUCT_ID,
          VARIANT_ID,
          buildUpdateDto({ quantity: -5 }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(inventoryRepoUpdate).not.toHaveBeenCalled();
    });

    it('missing or non-owned variant → 404 and nothing is written', async () => {
      variantRepoFindByIdAndProductId.mockResolvedValue(null);

      await expect(
        service.update(
          PRODUCT_ID,
          VARIANT_ID,
          buildUpdateDto({ quantity: 7 }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(inventoryRepoUpdate).not.toHaveBeenCalled();
    });

    it('no inventory row → 404', async () => {
      inventoryRepoFindByVariantId.mockResolvedValue(null);

      await expect(
        service.update(
          PRODUCT_ID,
          VARIANT_ID,
          buildUpdateDto({ quantity: 7 }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(inventoryRepoUpdate).not.toHaveBeenCalled();
    });

    it('translates a concurrent database check-constraint violation → 400', async () => {
      inventoryRepoUpdate.mockRejectedValue(buildCheckViolation());

      await expect(
        service.update(
          PRODUCT_ID,
          VARIANT_ID,
          buildUpdateDto({ quantity: 7 }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('never forwards variantId present on the dto', async () => {
      const dto = buildUpdateDto({ quantity: 7 }) as UpdateInventoryDto & {
        variantId?: string;
      };
      dto.variantId = 'other-variant';

      await service.update(PRODUCT_ID, VARIANT_ID, dto);

      expect(inventoryRepoUpdate.mock.calls[0][1]).not.toHaveProperty(
        'variantId',
      );
    });
  });
});
