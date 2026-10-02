import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  ProductImagesRepository,
  type CreateProductImageData,
} from './product-images.repository.js';

const buildImageData = (
  overrides: Partial<CreateProductImageData> = {},
): CreateProductImageData => ({
  productId: 'p-1',
  imageUrl: 'https://res.cloudinary.com/demo/image/upload/products/test/front.jpg',
  publicId: 'products/test/front',
  altText: 'Front',
  sortOrder: 0,
  isPrimary: true,
  ...overrides,
});

const buildImage = (overrides: Record<string, unknown> = {}) => ({
  id: 'i-1',
  productId: 'p-1',
  imageUrl: 'https://res.cloudinary.com/demo/image/upload/products/test/front.jpg',
  publicId: 'products/test/front',
  altText: 'Front',
  sortOrder: 0,
  isPrimary: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

describe('ProductImagesRepository', () => {
  let repository: ProductImagesRepository;
  let create: ReturnType<typeof vi.fn>;
  let findMany: ReturnType<typeof vi.fn>;
  let findUnique: ReturnType<typeof vi.fn>;
  let findFirst: ReturnType<typeof vi.fn>;
  let update: ReturnType<typeof vi.fn>;
  let updateMany: ReturnType<typeof vi.fn>;
  let deleteFn: ReturnType<typeof vi.fn>;
  let transaction: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    create = vi.fn();
    findMany = vi.fn();
    findUnique = vi.fn();
    findFirst = vi.fn();
    update = vi.fn();
    updateMany = vi.fn();
    deleteFn = vi.fn();
    transaction = vi.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductImagesRepository,
        {
          provide: PrismaService,
          useValue: {
            productImage: {
              create,
              findMany,
              findUnique,
              findFirst,
              update,
              updateMany,
              delete: deleteFn,
            },
            $transaction: transaction,
          },
        },
      ],
    }).compile();

    repository = module.get<ProductImagesRepository>(ProductImagesRepository);
  });

  it('should be defined', () => {
    expect(repository).toBeDefined();
  });

  describe('create', () => {
    it('forwards the supplied data unchanged', async () => {
      const data = buildImageData({ altText: null });
      const image = buildImage({ altText: null });
      create.mockResolvedValue(image);

      await expect(repository.create(data)).resolves.toBe(image);
      expect(create).toHaveBeenCalledWith({ data });
    });

    it('does not open a transaction for a plain create', async () => {
      create.mockResolvedValue(buildImage());

      await repository.create(buildImageData());

      expect(transaction).not.toHaveBeenCalled();
    });
  });

  describe('findAllByProductId', () => {
    it('orders by sortOrder then createdAt for a deterministic listing', async () => {
      const images = [buildImage(), buildImage({ id: 'i-2' })];
      findMany.mockResolvedValue(images);

      await expect(repository.findAllByProductId('p-1')).resolves.toBe(images);
      expect(findMany).toHaveBeenCalledWith({
        where: { productId: 'p-1' },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      });
    });

    it('returns an empty list when the product has no images', async () => {
      findMany.mockResolvedValue([]);

      await expect(repository.findAllByProductId('p-1')).resolves.toEqual([]);
    });
  });

  describe('findById', () => {
    it('queries the primary key and returns the entity', async () => {
      const image = buildImage();
      findUnique.mockResolvedValue(image);

      await expect(repository.findById('i-1')).resolves.toBe(image);
      expect(findUnique).toHaveBeenCalledWith({ where: { id: 'i-1' } });
    });

    it('returns null when no image matches', async () => {
      findUnique.mockResolvedValue(null);

      await expect(repository.findById('missing')).resolves.toBeNull();
    });
  });

  describe('findPrimaryByProductId', () => {
    it('filters on productId and isPrimary together', async () => {
      const image = buildImage();
      findFirst.mockResolvedValue(image);

      await expect(repository.findPrimaryByProductId('p-1')).resolves.toBe(image);
      expect(findFirst).toHaveBeenCalledWith({
        where: { productId: 'p-1', isPrimary: true },
      });
    });

    it('returns null when the product has no primary image', async () => {
      findFirst.mockResolvedValue(null);

      await expect(
        repository.findPrimaryByProductId('p-1'),
      ).resolves.toBeNull();
    });
  });

  describe('findByIdAndProductId', () => {
    it('filters by id AND owner in one query', async () => {
      const image = buildImage();
      findFirst.mockResolvedValue(image);

      await expect(
        repository.findByIdAndProductId('i-1', 'p-1'),
      ).resolves.toBe(image);
      expect(findFirst).toHaveBeenCalledWith({
        where: { id: 'i-1', productId: 'p-1' },
      });
    });

    it('returns null when the image belongs to another product', async () => {
      findFirst.mockResolvedValue(null);

      await expect(
        repository.findByIdAndProductId('i-1', 'other-product'),
      ).resolves.toBeNull();
    });
  });

  describe('update', () => {
    it('forwards only the given columns', async () => {
      const image = buildImage({ altText: 'Back' });
      update.mockResolvedValue(image);

      await expect(
        repository.update('i-1', { altText: 'Back' }),
      ).resolves.toBe(image);
      expect(update).toHaveBeenCalledWith({
        where: { id: 'i-1' },
        data: { altText: 'Back' },
      });
    });
  });

  describe('delete', () => {
    it('removes a single image by id', async () => {
      const image = buildImage();
      deleteFn.mockResolvedValue(image);

      await expect(repository.delete('i-1')).resolves.toBe(image);
      expect(deleteFn).toHaveBeenCalledWith({ where: { id: 'i-1' } });
    });
  });

  describe('transactional primary-image changes', () => {
    it('promoteToPrimary demotes the incumbent then promotes, in one transaction', async () => {
      const promoted = buildImage({ id: 'i-2', isPrimary: true });
      updateMany.mockResolvedValue({ count: 1 });
      update.mockResolvedValue(promoted);
      transaction.mockResolvedValue([{ count: 1 }, promoted]);

      await expect(
        repository.promoteToPrimary('p-1', 'i-2'),
      ).resolves.toBe(promoted);

      expect(updateMany).toHaveBeenCalledWith({
        where: { productId: 'p-1', isPrimary: true, id: { not: 'i-2' } },
        data: { isPrimary: false },
      });
      expect(update).toHaveBeenCalledWith({
        where: { id: 'i-2' },
        data: { isPrimary: true },
      });
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(transaction).toHaveBeenCalledWith([expect.anything(), expect.anything()]);
    });

    it('createAsPrimary demotes the incumbent and inserts as primary in one transaction', async () => {
      const created = buildImage({ id: 'i-3' });
      updateMany.mockResolvedValue({ count: 1 });
      create.mockResolvedValue(created);
      transaction.mockResolvedValue([{ count: 1 }, created]);

      const data = buildImageData({ productId: 'p-1', isPrimary: true });

      await expect(repository.createAsPrimary(data)).resolves.toBe(created);

      expect(updateMany).toHaveBeenCalledWith({
        where: { productId: 'p-1', isPrimary: true },
        data: { isPrimary: false },
      });
      expect(create).toHaveBeenCalledWith({
        data: { ...data, isPrimary: true },
      });
      expect(transaction).toHaveBeenCalledTimes(1);
    });

    it('updateAsPrimary writes the caller columns and the flag in one update', async () => {
      const updated = buildImage({ id: 'i-2', altText: 'Back', isPrimary: true });
      updateMany.mockResolvedValue({ count: 1 });
      update.mockResolvedValue(updated);
      transaction.mockResolvedValue([{ count: 1 }, updated]);

      await expect(
        repository.updateAsPrimary('i-2', 'p-1', { altText: 'Back' }),
      ).resolves.toBe(updated);

      expect(update).toHaveBeenCalledWith({
        where: { id: 'i-2' },
        data: { altText: 'Back', isPrimary: true },
      });
      expect(transaction).toHaveBeenCalledTimes(1);
    });

    it('updateAsPrimary with no columns still promotes exactly once', async () => {
      const updated = buildImage({ id: 'i-2', isPrimary: true });
      updateMany.mockResolvedValue({ count: 1 });
      update.mockResolvedValue(updated);
      transaction.mockResolvedValue([{ count: 1 }, updated]);

      await expect(
        repository.updateAsPrimary('i-2', 'p-1', {}),
      ).resolves.toBe(updated);

      expect(update).toHaveBeenCalledWith({
        where: { id: 'i-2' },
        data: { isPrimary: true },
      });
      expect(transaction).toHaveBeenCalledTimes(1);
    });
  });
});
