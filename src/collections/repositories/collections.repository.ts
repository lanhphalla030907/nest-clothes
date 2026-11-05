import { Injectable } from '@nestjs/common';
import { Prisma, type Collection, type Product } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

export interface CreateCollectionData {
  title: string;
  slug: string;
  description: string | null;
  coverImage: string;
  displayOrder: number;
  productIds: string[];
}

export interface UpdateCollectionData {
  title?: string;
  description?: string | null;
  displayOrder?: number;
  productIds?: string[];
}

const publicProductWhere: Prisma.ProductWhereInput = {
  isActive: true,
  status: 'ACTIVE',
};

@Injectable()
export class CollectionsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.collection.findMany({
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
      include: { _count: { select: { products: true } } },
    });
  }

  findActive(limit?: number) {
    return this.prisma.collection.findMany({
      where: { isActive: true },
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
      ...(limit === undefined ? {} : { take: limit }),
      include: { _count: { select: { products: true } } },
    });
  }

  findById(id: string) {
    return this.prisma.collection.findUnique({
      where: { id },
      include: { products: { include: { product: true } } },
    });
  }

  findPublicDetailBySlug(slug: string, page: number, limit: number) {
    return this.prisma.collection.findFirst({
      where: { slug, isActive: true },
      include: {
        products: {
          where: { product: publicProductWhere },
          include: { product: true },
          orderBy: { product: { createdAt: 'desc' } },
          skip: (page - 1) * limit,
          take: limit,
        },
        _count: { select: { products: { where: { product: publicProductWhere } } } },
      },
    });
  }

  findBySlug(slug: string): Promise<Collection | null> {
    return this.prisma.collection.findUnique({ where: { slug } });
  }

  findProductsByIds(ids: string[]): Promise<Pick<Product, 'id'>[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true } });
  }

  create(data: CreateCollectionData) {
    return this.prisma.collection.create({
      data: {
        title: data.title,
        slug: data.slug,
        description: data.description,
        coverImage: data.coverImage,
        displayOrder: data.displayOrder,
        products: { create: data.productIds.map((productId) => ({ productId })) },
      },
      include: { products: { include: { product: true } } },
    });
  }

  update(id: string, data: UpdateCollectionData) {
    return this.prisma.collection.update({
      where: { id },
      data: {
        ...(data.title === undefined ? {} : { title: data.title }),
        ...(data.description === undefined ? {} : { description: data.description }),
        ...(data.displayOrder === undefined ? {} : { displayOrder: data.displayOrder }),
        ...(data.productIds === undefined
          ? {}
          : { products: { deleteMany: {}, create: data.productIds.map((productId) => ({ productId })) } }),
      },
      include: { products: { include: { product: true } } },
    });
  }

  updateCoverImage(id: string, coverImage: string) {
    return this.prisma.collection.update({ where: { id }, data: { coverImage } });
  }

  updateStatus(id: string, isActive: boolean): Promise<Collection> {
    return this.prisma.collection.update({ where: { id }, data: { isActive } });
  }

  delete(id: string): Promise<Collection> {
    return this.prisma.collection.delete({ where: { id } });
  }
}
