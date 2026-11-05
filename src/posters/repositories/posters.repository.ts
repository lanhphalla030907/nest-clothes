import { Injectable } from '@nestjs/common';
import type { Poster } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * The exact columns `PostersRepository.create` is allowed to write.
 *
 * `id`, `createdAt` and `updatedAt` are intentionally missing: they are
 * database-owned and must never be reachable from a request payload.
 */
export interface CreatePosterData {
  title: string | null;
  imageUrl: string;
  publicId: string;
  isActive: boolean;
  displayOrder: number;
}

/** The subset of columns an update may write. Absent keys are left untouched. */
export interface UpdatePosterData {
  title?: string | null;
  isActive?: boolean;
  displayOrder?: number;
  imageUrl?: string;
  publicId?: string;
}

/**
 * The only place in the posters feature that talks to the database.
 *
 * It owns Poster persistence and nothing else: no exception mapping, no DTO
 * mapping and no Cloudinary access.
 */
@Injectable()
export class PostersRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Persists a new poster and returns the stored entity. */
  create(data: CreatePosterData): Promise<Poster> {
    return this.prisma.poster.create({ data });
  }

  /** Returns every poster, in display order for the management screen. */
  findAll(): Promise<Poster[]> {
    return this.prisma.poster.findMany({
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /** Returns only active posters, in display order for the storefront. */
  findActive(): Promise<Poster[]> {
    return this.prisma.poster.findMany({
      where: { isActive: true },
      orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /** Returns the poster owning `id`, or `null` when no such poster exists. */
  findById(id: string): Promise<Poster | null> {
    return this.prisma.poster.findUnique({ where: { id } });
  }

  /** Writes only the columns present in `data`. */
  update(id: string, data: UpdatePosterData): Promise<Poster> {
    return this.prisma.poster.update({ where: { id }, data });
  }

  /** Removes the poster owning `id` and returns the row as it was. */
  delete(id: string): Promise<Poster> {
    return this.prisma.poster.delete({ where: { id } });
  }
}
