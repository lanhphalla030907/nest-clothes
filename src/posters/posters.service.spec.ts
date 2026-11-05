import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { CloudinaryService } from '../cloudinary/cloudinary.service.js';
import type { Poster } from '../generated/prisma/client.js';
import { PosterResponseDto } from './dto/poster-response.dto.js';
import type { UploadedPosterImageFile } from './interfaces/uploaded-poster-image-file.js';
import { PostersService } from './posters.service.js';
import { PostersRepository } from './repositories/posters.repository.js';

const buildPoster = (overrides: Partial<Poster> = {}): Poster => ({
  id: 'poster-1',
  title: 'Summer sale',
  imageUrl: 'https://cdn.example.com/poster.jpg',
  publicId: 'posters/poster-1',
  isActive: true,
  displayOrder: 0,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

const buildFile = (): UploadedPosterImageFile => ({
  buffer: Buffer.from('image-bytes'),
  mimetype: 'image/jpeg',
});

const buildUploadResult = (publicId = 'posters/new') => ({
  secureUrl: `https://cdn.example.com/${publicId}.jpg`,
  publicId,
  width: 1200,
  height: 600,
  format: 'jpg',
  bytes: 11,
});

describe('PostersService', () => {
  let service: PostersService;
  let repositoryCreate: ReturnType<typeof vi.fn>;
  let repositoryFindAll: ReturnType<typeof vi.fn>;
  let repositoryFindActive: ReturnType<typeof vi.fn>;
  let repositoryFindById: ReturnType<typeof vi.fn>;
  let repositoryUpdate: ReturnType<typeof vi.fn>;
  let repositoryDelete: ReturnType<typeof vi.fn>;
  let cloudinaryUpload: ReturnType<typeof vi.fn>;
  let cloudinaryDelete: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();

    repositoryCreate = vi.fn();
    repositoryFindAll = vi.fn();
    repositoryFindActive = vi.fn();
    repositoryFindById = vi.fn();
    repositoryUpdate = vi.fn();
    repositoryDelete = vi.fn();
    cloudinaryUpload = vi.fn();
    cloudinaryDelete = vi.fn().mockResolvedValue(true);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PostersService,
        {
          provide: PostersRepository,
          useValue: {
            create: repositoryCreate,
            findAll: repositoryFindAll,
            findActive: repositoryFindActive,
            findById: repositoryFindById,
            update: repositoryUpdate,
            delete: repositoryDelete,
          },
        },
        {
          provide: CloudinaryService,
          useValue: {
            upload: cloudinaryUpload,
            deleteAsset: cloudinaryDelete,
          },
        },
      ],
    }).compile();

    service = module.get<PostersService>(PostersService);
  });

  it('maps active posters through the response DTO', async () => {
    repositoryFindActive.mockResolvedValue([buildPoster()]);

    const result = await service.findActive();

    expect(repositoryFindActive).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(PosterResponseDto);
    expect(result[0].publicId).toBe('posters/poster-1');
  });

  it('rejects an unknown poster with 404', async () => {
    repositoryFindById.mockResolvedValue(null);

    await expect(service.findOne('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('updates poster metadata without touching its image', async () => {
    repositoryFindById.mockResolvedValue(buildPoster());
    repositoryUpdate.mockImplementation((_id: string, data: Partial<Poster>) =>
      Promise.resolve(buildPoster(data)),
    );

    const result = await service.update('poster-1', {
      title: 'Autumn sale',
      isActive: false,
      displayOrder: 2,
    });

    expect(repositoryUpdate).toHaveBeenCalledWith('poster-1', {
      title: 'Autumn sale',
      isActive: false,
      displayOrder: 2,
    });
    expect(result.title).toBe('Autumn sale');
    expect(result.isActive).toBe(false);
    expect(result.displayOrder).toBe(2);
  });

  it('creates a poster from an uploaded image', async () => {
    cloudinaryUpload.mockResolvedValue(buildUploadResult('posters/new'));
    repositoryCreate.mockImplementation((data: Partial<Poster>) =>
      Promise.resolve(buildPoster(data)),
    );

    const result = await service.createWithImage(
      { title: 'New poster' },
      buildFile(),
    );

    expect(cloudinaryUpload).toHaveBeenCalledWith({
      buffer: Buffer.from('image-bytes'),
      mimeType: 'image/jpeg',
    });
    expect(repositoryCreate).toHaveBeenCalledWith({
      title: 'New poster',
      imageUrl: 'https://cdn.example.com/posters/new.jpg',
      publicId: 'posters/new',
      isActive: true,
      displayOrder: 0,
    });
    expect(result.imageUrl).toBe('https://cdn.example.com/posters/new.jpg');
  });

  it('rejects create without a usable file before uploading', async () => {
    await expect(service.createWithImage({}, undefined)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(cloudinaryUpload).not.toHaveBeenCalled();
  });

  it('deletes the newly uploaded asset when the poster insert fails', async () => {
    cloudinaryUpload.mockResolvedValue(buildUploadResult('posters/orphan'));
    repositoryCreate.mockRejectedValue(new Error('database down'));

    await expect(service.createWithImage({}, buildFile())).rejects.toThrow(
      'database down',
    );

    expect(cloudinaryDelete).toHaveBeenCalledWith('posters/orphan');
  });

  it('replaces the image and removes the previous asset', async () => {
    repositoryFindById.mockResolvedValue(
      buildPoster({ publicId: 'posters/old' }),
    );
    cloudinaryUpload.mockResolvedValue(buildUploadResult('posters/new'));
    repositoryUpdate.mockImplementation((_id: string, data: Partial<Poster>) =>
      Promise.resolve(buildPoster(data)),
    );

    const result = await service.uploadImage('poster-1', buildFile(), {});

    expect(repositoryUpdate).toHaveBeenCalledWith(
      'poster-1',
      expect.objectContaining({
        imageUrl: 'https://cdn.example.com/posters/new.jpg',
        publicId: 'posters/new',
        displayOrder: 0,
      }),
    );
    expect(cloudinaryDelete).toHaveBeenCalledWith('posters/old');
    expect(result.publicId).toBe('posters/new');
  });

  it('removes the row and then cleans up its Cloudinary asset', async () => {
    repositoryFindById.mockResolvedValue(
      buildPoster({ publicId: 'posters/delete-me' }),
    );

    await service.remove('poster-1');

    expect(repositoryDelete).toHaveBeenCalledWith('poster-1');
    expect(cloudinaryDelete).toHaveBeenCalledWith('posters/delete-me');
  });
});
