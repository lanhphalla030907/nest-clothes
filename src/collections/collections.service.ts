import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { normalizeSlug } from '../common/utils/normalize-slug.js';
import { CloudinaryService } from '../cloudinary/cloudinary.service.js';
import { CreateCollectionDto } from './dto/create-collection.dto.js';
import { CollectionResponseDto } from './dto/collection-response.dto.js';
import { UpdateCollectionDto } from './dto/update-collection.dto.js';
import type { UploadedCollectionImageFile } from './interfaces/uploaded-collection-image-file.js';
import { CollectionsRepository } from './repositories/collections.repository.js';

@Injectable()
export class CollectionsService {
  constructor(
    private readonly collectionsRepository: CollectionsRepository,
    private readonly cloudinaryService: CloudinaryService,
  ) {}

  async findAll(): Promise<CollectionResponseDto[]> {
    const collections = await this.collectionsRepository.findAll();
    return collections.map((collection) => CollectionResponseDto.fromEntity(collection, collection._count.products));
  }

  async findActive(limit?: number): Promise<CollectionResponseDto[]> {
    const collections = await this.collectionsRepository.findActive(limit);
    return collections.map((collection) => CollectionResponseDto.fromEntity(collection, collection._count.products));
  }

  async findOne(id: string) {
    const collection = await this.requireCollection(id);
    return {
      collection: CollectionResponseDto.fromEntity(collection, collection.products.length),
      products: collection.products.map(({ product }) => product),
    };
  }

  async findPublicDetail(slug: string, page = 1, limit = 12) {
    const collection = await this.collectionsRepository.findPublicDetailBySlug(slug, page, limit);
    if (!collection) throw new NotFoundException('Collection does not exist or is not active');
    const total = collection._count.products;
    return {
      collection: CollectionResponseDto.fromEntity(collection, total),
      products: collection.products.map(({ product }) => product),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async createWithImage(dto: CreateCollectionDto, file: UploadedCollectionImageFile | undefined) {
    const slug = normalizeSlug(dto.title);
    await this.assertSlugAvailable(slug);
    await this.assertProductsExist(dto.productIds ?? []);
    const uploaded = await this.upload(file);
    try {
      const collection = await this.collectionsRepository.create({
        title: dto.title.trim(), slug, description: this.description(dto.description), coverImage: uploaded.secureUrl,
        displayOrder: dto.displayOrder ?? 0, productIds: dto.productIds ?? [],
      });
      return CollectionResponseDto.fromEntity(collection, collection.products.length);
    } catch (error) {
      throw this.mapUniqueError(error);
    }
  }

  async update(id: string, dto: UpdateCollectionDto) {
    await this.requireCollection(id);
    if (dto.productIds !== undefined) await this.assertProductsExist(dto.productIds);
    const collection = await this.collectionsRepository.update(id, {
      ...(dto.title === undefined ? {} : { title: dto.title.trim() }),
      ...(dto.description === undefined ? {} : { description: this.description(dto.description) }),
      ...(dto.displayOrder === undefined ? {} : { displayOrder: dto.displayOrder }),
      ...(dto.productIds === undefined ? {} : { productIds: dto.productIds }),
    });
    return CollectionResponseDto.fromEntity(collection, collection.products.length);
  }

  async replaceImage(id: string, file: UploadedCollectionImageFile | undefined) {
    await this.requireCollection(id);
    const uploaded = await this.upload(file);
    const collection = await this.collectionsRepository.updateCoverImage(id, uploaded.secureUrl);
    // Deliberately retain the previous remote image: ownership-safe Cloudinary cleanup
    // cannot be inferred from a URL-only collection record.
    return CollectionResponseDto.fromEntity(collection);
  }

  async updateStatus(id: string, isActive: boolean): Promise<CollectionResponseDto> {
    await this.requireCollection(id);
    return CollectionResponseDto.fromEntity(await this.collectionsRepository.updateStatus(id, isActive));
  }

  async remove(id: string): Promise<void> {
    await this.requireCollection(id);
    await this.collectionsRepository.delete(id);
  }

  private async requireCollection(id: string) {
    const collection = await this.collectionsRepository.findById(id);
    if (!collection) throw new NotFoundException(`Collection ${id} does not exist`);
    return collection;
  }

  private async assertSlugAvailable(slug: string): Promise<void> {
    if (await this.collectionsRepository.findBySlug(slug)) {
      throw new ConflictException('A collection with this title already exists');
    }
  }

  private async assertProductsExist(ids: string[]): Promise<void> {
    const products = await this.collectionsRepository.findProductsByIds(ids);
    if (products.length !== ids.length) throw new BadRequestException('One or more selected products do not exist');
  }

  private description(value: string | null | undefined): string | null {
    return value === undefined || value === null || value.trim() === '' ? null : value.trim();
  }

  private async upload(file: UploadedCollectionImageFile | undefined) {
    if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
      throw new BadRequestException('Cover image file is required');
    }
    return this.cloudinaryService.upload({ buffer: file.buffer, mimeType: file.mimetype });
  }

  private mapUniqueError(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ConflictException('A collection with this title already exists');
    }
    throw error;
  }
}
