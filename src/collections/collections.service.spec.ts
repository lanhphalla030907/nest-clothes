import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { CloudinaryService } from '../cloudinary/cloudinary.service.js';
import { CollectionsService } from './collections.service.js';
import { CollectionsRepository } from './repositories/collections.repository.js';

const product = { id: '0f93ee96-bccb-41d2-b7a7-40e65e7b8269', categoryId: 'b20ef0f0-5f23-4f6d-b7a9-b7f4dfc5bc33', name: 'Jacket', slug: 'jacket', description: null, basePrice: '100.00', status: 'ACTIVE', isActive: true, createdAt: new Date(), updatedAt: new Date() };
const collection = (overrides = {}) => ({
  id: 'bcef39ed-97c0-4fc7-b7de-5242ad7b95c9', title: 'Outerwear', slug: 'outerwear', description: null,
  coverImage: 'https://cdn.example.com/outerwear.jpg', isActive: true, displayOrder: 0, createdAt: new Date(), updatedAt: new Date(),
  products: [{ product }], ...overrides,
});
const file = { buffer: Buffer.from('image'), mimetype: 'image/jpeg' };

describe('CollectionsService', () => {
  let service: CollectionsService;
  let repository: Record<string, ReturnType<typeof vi.fn>>;
  let upload: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    repository = Object.fromEntries(['findAll', 'findActive', 'findById', 'findPublicDetailBySlug', 'findBySlug', 'findProductsByIds', 'create', 'update', 'updateCoverImage', 'updateStatus', 'delete'].map((name) => [name, vi.fn()])) as Record<string, ReturnType<typeof vi.fn>>;
    upload = vi.fn();
    const module: TestingModule = await Test.createTestingModule({
      providers: [CollectionsService, { provide: CollectionsRepository, useValue: repository }, { provide: CloudinaryService, useValue: { upload } }],
    }).compile();
    service = module.get(CollectionsService);
  });

  it('creates a collection with an uploaded cover and product assignments', async () => {
    upload.mockResolvedValue({ secureUrl: 'https://cdn.example.com/new.jpg' });
    repository.findBySlug.mockResolvedValue(null);
    repository.findProductsByIds.mockResolvedValue([{ id: product.id }]);
    repository.create.mockResolvedValue(collection());

    await service.createWithImage({ title: 'Outerwear', productIds: [product.id], displayOrder: 2 }, file);

    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ slug: 'outerwear', coverImage: 'https://cdn.example.com/new.jpg', productIds: [product.id], displayOrder: 2 }));
  });

  it('rejects a duplicate generated slug', async () => {
    upload.mockResolvedValue({ secureUrl: 'https://cdn.example.com/new.jpg' });
    repository.findBySlug.mockResolvedValue(collection());
    await expect(service.createWithImage({ title: 'Outerwear' }, file)).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects product assignments that reference a missing product', async () => {
    upload.mockResolvedValue({ secureUrl: 'https://cdn.example.com/new.jpg' });
    repository.findBySlug.mockResolvedValue(null);
    repository.findProductsByIds.mockResolvedValue([]);
    await expect(service.createWithImage({ title: 'Outerwear', productIds: [product.id] }, file)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('keeps a replacement image on the collection without deleting unknown remote assets', async () => {
    repository.findById.mockResolvedValue(collection());
    upload.mockResolvedValue({ secureUrl: 'https://cdn.example.com/replacement.jpg' });
    repository.updateCoverImage.mockResolvedValue(collection({ coverImage: 'https://cdn.example.com/replacement.jpg' }));
    await service.replaceImage('bcef39ed-97c0-4fc7-b7de-5242ad7b95c9', file);
    expect(repository.updateCoverImage).toHaveBeenCalledWith('bcef39ed-97c0-4fc7-b7de-5242ad7b95c9', 'https://cdn.example.com/replacement.jpg');
  });

  it('replaces the assigned product set when an admin edits a collection', async () => {
    const replacementId = '64d2490b-2b30-4a7d-8136-62b2f12f0aac';
    repository.findById.mockResolvedValue(collection());
    repository.findProductsByIds.mockResolvedValue([{ id: replacementId }]);
    repository.update.mockResolvedValue(collection({ products: [] }));
    await service.update('bcef39ed-97c0-4fc7-b7de-5242ad7b95c9', { productIds: [replacementId] });
    expect(repository.update).toHaveBeenCalledWith('bcef39ed-97c0-4fc7-b7de-5242ad7b95c9', { productIds: [replacementId] });
  });

  it('does not expose paused collections through the public detail query', async () => {
    repository.findPublicDetailBySlug.mockResolvedValue(null);
    await expect(service.findPublicDetail('outerwear')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns collection products with pagination metadata', async () => {
    repository.findPublicDetailBySlug.mockResolvedValue({ ...collection(), _count: { products: 13 } });
    const result = await service.findPublicDetail('outerwear', 2, 12);
    expect(result.pagination).toEqual({ page: 2, limit: 12, total: 13, totalPages: 2 });
    expect(result.products).toEqual([product]);
  });
});
