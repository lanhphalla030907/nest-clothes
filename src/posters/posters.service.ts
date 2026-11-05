import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CloudinaryService } from '../cloudinary/cloudinary.service.js';
import type { Poster } from '../generated/prisma/client.js';
import { PosterResponseDto } from './dto/poster-response.dto.js';
import { UpdatePosterDto } from './dto/update-poster.dto.js';
import { UploadPosterImageDto } from './dto/upload-poster-image.dto.js';
import type { UploadedPosterImageFile } from './interfaces/uploaded-poster-image-file.js';
import {
  PostersRepository,
  type UpdatePosterData,
} from './repositories/posters.repository.js';

/**
 * All poster business rules live here; the repository only knows about SQL and
 * the controllers only know about HTTP.
 *
 * Uploads and local writes cannot share a transaction, so the upload paths
 * delete a newly uploaded Cloudinary asset when the database write fails, and
 * delete the previous asset only after the row points at the replacement.
 */
@Injectable()
export class PostersService {
  private readonly logger = new Logger(PostersService.name);

  constructor(
    private readonly postersRepository: PostersRepository,
    private readonly cloudinaryService: CloudinaryService,
  ) {}

  async findAll(): Promise<PosterResponseDto[]> {
    const posters = await this.postersRepository.findAll();

    return posters.map((poster) => PosterResponseDto.fromEntity(poster));
  }

  async findActive(): Promise<PosterResponseDto[]> {
    const posters = await this.postersRepository.findActive();

    return posters.map((poster) => PosterResponseDto.fromEntity(poster));
  }

  async findOne(id: string): Promise<PosterResponseDto> {
    const poster = await this.requirePoster(id);

    return PosterResponseDto.fromEntity(poster);
  }

  async update(id: string, dto: UpdatePosterDto): Promise<PosterResponseDto> {
    await this.requirePoster(id);

    const poster = await this.postersRepository.update(id, {
      title: dto.title ?? undefined,
      isActive: dto.isActive,
      displayOrder: dto.displayOrder,
    });

    return PosterResponseDto.fromEntity(poster);
  }

  async remove(id: string): Promise<void> {
    const poster = await this.requirePoster(id);

    await this.postersRepository.delete(id);

    if (poster.publicId) {
      await this.cloudinaryService
        .deleteAsset(poster.publicId)
        .catch((error) => this.logger.error(String(error)));
    }
  }

  /**
   * Uploads a replacement image for `id` and records its Cloudinary metadata.
   *
   * The new asset is uploaded first, the row is updated second, and the old
   * asset is deleted last. If the row update fails, the new asset is removed so
   * it cannot become an orphan.
   */
  async uploadImage(
    id: string,
    file: UploadedPosterImageFile | undefined,
    dto: UploadPosterImageDto,
  ): Promise<PosterResponseDto> {
    const existing = await this.requirePoster(id);
    const previousPublicId = existing.publicId;
    const uploadedFile = this.assertFileIsPresent(file);

    const uploaded = await this.cloudinaryService.upload({
      buffer: uploadedFile.buffer,
      mimeType: uploadedFile.mimetype,
    });

    const data: UpdatePosterData = {
      imageUrl: uploaded.secureUrl,
      publicId: uploaded.publicId,
      title: dto.title ?? existing.title,
      displayOrder: dto.displayOrder ?? existing.displayOrder,
    };

    let poster: Poster;

    try {
      poster = await this.postersRepository.update(id, data);
    } catch (error) {
      await this.compensateFailedUpload(uploaded.publicId, error);

      throw error;
    }

    if (previousPublicId && previousPublicId !== uploaded.publicId) {
      await this.cloudinaryService
        .deleteAsset(previousPublicId)
        .catch((error) => this.logger.error(String(error)));
    }

    return PosterResponseDto.fromEntity(poster);
  }

  /**
   * Creates a poster from the uploaded image and its form metadata.
   *
   * A poster has no meaningful representation without an image, so a missing
   * file is rejected before Cloudinary is called.
   */
  async createWithImage(
    dto: UploadPosterImageDto,
    file: UploadedPosterImageFile | undefined,
  ): Promise<PosterResponseDto> {
    const uploadedFile = this.assertFileIsPresent(file);

    const uploaded = await this.cloudinaryService.upload({
      buffer: uploadedFile.buffer,
      mimeType: uploadedFile.mimetype,
    });

    try {
      const poster = await this.postersRepository.create({
        title: dto.title ?? null,
        imageUrl: uploaded.secureUrl,
        publicId: uploaded.publicId,
        isActive: true,
        displayOrder: dto.displayOrder ?? 0,
      });

      return PosterResponseDto.fromEntity(poster);
    } catch (error) {
      await this.compensateFailedUpload(uploaded.publicId, error);

      throw error;
    }
  }

  /** Loads a poster or rejects the request with 404. */
  private async requirePoster(id: string): Promise<Poster> {
    const poster = await this.postersRepository.findById(id);

    if (!poster) {
      throw new NotFoundException(`Poster ${id} does not exist`);
    }

    return poster;
  }

  /** Rejects a request that carried no usable file part. */
  private assertFileIsPresent(
    file: UploadedPosterImageFile | undefined,
  ): UploadedPosterImageFile {
    if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
      throw new BadRequestException('Image file is required');
    }

    return file;
  }

  /**
   * Deletes an asset whose database write failed, then rethrows the original
   * error. Cleanup failure is logged but never masks the original failure.
   */
  private async compensateFailedUpload(
    publicId: string,
    originalError: unknown,
  ): Promise<void> {
    try {
      await this.cloudinaryService.deleteAsset(publicId);
    } catch (compensationError) {
      this.logger.error(
        `Failed to remove orphaned Cloudinary asset ${publicId} after a poster database error: ${String(originalError)} (cleanup error: ${String(compensationError)})`,
      );
    }
  }
}
