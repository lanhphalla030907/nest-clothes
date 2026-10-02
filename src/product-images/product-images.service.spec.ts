import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CLOUDINARY_MAX_FILE_SIZE_BYTES } from '../cloudinary/cloudinary.constants.js';
import { CloudinaryService } from '../cloudinary/cloudinary.service.js';
import {
  CLOUDINARY_CLIENT,
  CLOUDINARY_CREDENTIALS,
  type CloudinaryCredentials,
} from '../cloudinary/cloudinary.types.js';
import { ProductsRepository } from '../products/repositories/products.repository.js';
import { CreateProductImageDto } from './dto/create-product-image.dto.js';
import { ProductImagesService } from './product-images.service.js';
import { UpdateProductImageDto } from './dto/update-product-image.dto.js';
import { UploadProductImageDto } from './dto/upload-product-image.dto.js';
import type { UploadedImageFile } from './interfaces/uploaded-image-file.js';
import { ProductImagesRepository } from './repositories/product-images.repository.js';

const PRODUCT_ID = 'a1b2c3d4-e5f6-4f70-8a9b-0c1d2e3f4a5b';
const OTHER_PRODUCT_ID = 'b1b2c3d4-e5f6-4f70-8a9b-0c1d2e3f4a5b';
const IMAGE_ID = 'c1b2c3d4-e5f6-4f70-8a9b-0c1d2e3f4a5b';

const IMAGE_URL = 'https://res.cloudinary.com/demo/image/upload/products/test/front.jpg';
const PUBLIC_ID = 'products/test/front';

/** The public id Cloudinary assigned — deliberately different from any client input. */
const CLOUDINARY_PUBLIC_ID = 'products/t3zj4kq8u9abcdef';
const CLOUDINARY_SECURE_URL =
  'https://res.cloudinary.com/demo/image/upload/v1750000000/products/t3zj4kq8u9abcdef.jpg';

/** A real PNG header, so the buffer is not just zero bytes. */
const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

/**
 * Stand-in credentials for the tests that exercise the real `CloudinaryService`.
 *
 * Obvious non-values, so a leaked credential can never be mistaken for a working
 * one, and never accidentally valid against a real account.
 */
const TEST_CREDENTIALS: CloudinaryCredentials = Object.freeze({
  cloudName: 'test-cloud-not-real',
  apiKey: '000000000000000',
  apiSecret: 'test-secret-not-real',
});

const buildCloudinaryUploadResult = (overrides: Record<string, unknown> = {}) => ({
  secureUrl: CLOUDINARY_SECURE_URL,
  publicId: CLOUDINARY_PUBLIC_ID,
  width: 1200,
  height: 1600,
  format: 'png',
  bytes: PNG_BYTES.length,
  ...overrides,
});

const buildUploadedFile = (
  overrides: Partial<UploadedImageFile> = {},
): UploadedImageFile => ({
  originalname: 'front.png',
  size: PNG_BYTES.length,
  mimetype: 'image/png',
  buffer: PNG_BYTES,
  ...overrides,
});

const buildUploadDto = (
  overrides: Partial<UploadProductImageDto> = {},
): UploadProductImageDto =>
  Object.assign(new UploadProductImageDto(), overrides);

const buildCreateDto = (
  overrides: Partial<CreateProductImageDto> = {},
): CreateProductImageDto =>
  Object.assign(new CreateProductImageDto(), {
    productId: PRODUCT_ID,
    imageUrl: IMAGE_URL,
    publicId: PUBLIC_ID,
    altText: 'Front',
    sortOrder: 0,
    isPrimary: false,
    ...overrides,
  });

const buildUpdateDto = (
  overrides: Partial<UpdateProductImageDto> = {},
): UpdateProductImageDto => Object.assign(new UpdateProductImageDto(), overrides);

const buildProduct = (overrides: Record<string, unknown> = {}) => ({
  id: PRODUCT_ID,
  categoryId: 'cat-1',
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

const buildImage = (overrides: Record<string, unknown> = {}) => ({
  id: IMAGE_ID,
  productId: PRODUCT_ID,
  imageUrl: IMAGE_URL,
  publicId: PUBLIC_ID,
  altText: 'Front',
  sortOrder: 0,
  isPrimary: false,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

describe('ProductImagesService', () => {
  let service: ProductImagesService;
  let imageRepoCreate: ReturnType<typeof vi.fn>;
  let imageRepoCreateAsPrimary: ReturnType<typeof vi.fn>;
  let imageRepoFindAllByProductId: ReturnType<typeof vi.fn>;
  let imageRepoFindByIdAndProductId: ReturnType<typeof vi.fn>;
  let imageRepoFindPrimaryByProductId: ReturnType<typeof vi.fn>;
  let imageRepoUpdate: ReturnType<typeof vi.fn>;
  let imageRepoUpdateAsPrimary: ReturnType<typeof vi.fn>;
  let imageRepoDelete: ReturnType<typeof vi.fn>;
  let productRepoFindById: ReturnType<typeof vi.fn>;
  let cloudinaryUpload: ReturnType<typeof vi.fn>;
  let cloudinaryDeleteAsset: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    imageRepoCreate = vi.fn();
    imageRepoCreateAsPrimary = vi.fn();
    imageRepoFindAllByProductId = vi.fn();
    imageRepoFindByIdAndProductId = vi.fn();
    imageRepoFindPrimaryByProductId = vi.fn();
    imageRepoUpdate = vi.fn();
    imageRepoUpdateAsPrimary = vi.fn();
    imageRepoDelete = vi.fn();
    productRepoFindById = vi.fn();
    cloudinaryUpload = vi.fn();
    cloudinaryDeleteAsset = vi.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductImagesService,
        {
          provide: ProductImagesRepository,
          useValue: {
            create: imageRepoCreate,
            createAsPrimary: imageRepoCreateAsPrimary,
            findAllByProductId: imageRepoFindAllByProductId,
            findByIdAndProductId: imageRepoFindByIdAndProductId,
            findPrimaryByProductId: imageRepoFindPrimaryByProductId,
            update: imageRepoUpdate,
            updateAsPrimary: imageRepoUpdateAsPrimary,
            delete: imageRepoDelete,
          },
        },
        {
          provide: ProductsRepository,
          useValue: { findById: productRepoFindById },
        },
        {
          provide: CloudinaryService,
          useValue: {
            upload: cloudinaryUpload,
            deleteAsset: cloudinaryDeleteAsset,
          },
        },
      ],
    }).compile();

    service = module.get<ProductImagesService>(ProductImagesService);

    productRepoFindById.mockResolvedValue(buildProduct());

    /**
     * Default happy-path stubs for the remote system. Every test that cares about
     * the Cloudinary interaction overrides these explicitly, so a test that forgets
     * to set one up fails on the mock's return value rather than silently passing
     * against a leftover mock from a previous test.
     */
    cloudinaryUpload.mockResolvedValue(buildCloudinaryUploadResult());
    cloudinaryDeleteAsset.mockResolvedValue(true);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    beforeEach(() => {
      imageRepoCreate.mockImplementation((data: Record<string, unknown>) =>
        Promise.resolve(buildImage(data)),
      );
      imageRepoCreateAsPrimary.mockImplementation((data: Record<string, unknown>) =>
        Promise.resolve(buildImage(data)),
      );
    });

    it('creates a valid image', async () => {
      const result = await service.create(
        PRODUCT_ID,
        buildCreateDto({ imageUrl: `  ${IMAGE_URL}  `, publicId: `  ${PUBLIC_ID}  ` }),
      );

      expect(imageRepoCreate).toHaveBeenCalledWith({
        productId: PRODUCT_ID,
        imageUrl: IMAGE_URL,
        publicId: PUBLIC_ID,
        altText: 'Front',
        sortOrder: 0,
        isPrimary: false,
      });
      expect(result).toMatchObject({
        id: IMAGE_ID,
        productId: PRODUCT_ID,
        imageUrl: IMAGE_URL,
        publicId: PUBLIC_ID,
        altText: 'Front',
        sortOrder: 0,
        isPrimary: false,
      });
    });

    it('defaults sortOrder to 0 and isPrimary to false when omitted', async () => {
      const dto = buildCreateDto();
      delete (dto as Record<string, unknown>).sortOrder;
      delete (dto as Record<string, unknown>).isPrimary;
      delete (dto as Record<string, unknown>).altText;

      await service.create(PRODUCT_ID, dto);

      expect(imageRepoCreate).toHaveBeenCalledWith({
        productId: PRODUCT_ID,
        imageUrl: IMAGE_URL,
        publicId: PUBLIC_ID,
        altText: null,
        sortOrder: 0,
        isPrimary: false,
      });
    });

    it('missing product → 404', async () => {
      productRepoFindById.mockResolvedValue(null);

      await expect(
        service.create(PRODUCT_ID, buildCreateDto()),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(imageRepoCreate).not.toHaveBeenCalled();
    });

    it('primary image creation goes through the transactional path', async () => {
      const result = await service.create(
        PRODUCT_ID,
        buildCreateDto({ isPrimary: true }),
      );

      expect(imageRepoCreateAsPrimary).toHaveBeenCalledWith({
        productId: PRODUCT_ID,
        imageUrl: IMAGE_URL,
        publicId: PUBLIC_ID,
        altText: 'Front',
        sortOrder: 0,
        isPrimary: true,
      });
      expect(imageRepoCreate).not.toHaveBeenCalled();
      expect(result.isPrimary).toBe(true);
    });

    it('a second primary replaces the existing primary instead of rejecting', async () => {
      await service.create(PRODUCT_ID, buildCreateDto({ isPrimary: true }));

      expect(imageRepoCreateAsPrimary).toHaveBeenCalledTimes(1);
      expect(imageRepoCreate).not.toHaveBeenCalled();
    });

    it('trims surrounding whitespace on text fields', async () => {
      await service.create(
        PRODUCT_ID,
        buildCreateDto({ publicId: '  products/test/back  ', altText: '  Back  ' }),
      );

      expect(imageRepoCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          publicId: 'products/test/back',
          altText: 'Back',
        }),
      );
    });

    it('a body productId that disagrees with the path → 400', async () => {
      await expect(
        service.create(OTHER_PRODUCT_ID, buildCreateDto()),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(imageRepoCreate).not.toHaveBeenCalled();
      expect(productRepoFindById).not.toHaveBeenCalled();
    });

    it('database errors propagate untouched', async () => {
      imageRepoCreate.mockRejectedValue(new Error('connection terminated'));

      await expect(
        service.create(PRODUCT_ID, buildCreateDto()),
      ).rejects.toThrow('connection terminated');
    });

    it('a unique-constraint error propagates as a 500, not a 400', async () => {
      imageRepoCreateAsPrimary.mockRejectedValue(
        new Error('duplicate key value violates unique constraint'),
      );

      await expect(
        service.create(PRODUCT_ID, buildCreateDto({ isPrimary: true })),
      ).rejects.toThrow(/unique constraint/);
    });
  });

  describe('findAllByProductId', () => {
    it('lists the product images in repository order', async () => {
      const images = [
        buildImage({ id: 'i-1', sortOrder: 0 }),
        buildImage({ id: 'i-2', sortOrder: 1 }),
      ];
      imageRepoFindAllByProductId.mockResolvedValue(images);

      const result = await service.findAllByProductId(PRODUCT_ID);

      expect(result.map((image) => image.id)).toEqual(['i-1', 'i-2']);
      expect(imageRepoFindAllByProductId).toHaveBeenCalledWith(PRODUCT_ID);
    });

    it('returns an empty array when the product has no images', async () => {
      imageRepoFindAllByProductId.mockResolvedValue([]);

      await expect(service.findAllByProductId(PRODUCT_ID)).resolves.toEqual([]);
    });

    it('missing product → 404', async () => {
      productRepoFindById.mockResolvedValue(null);

      await expect(service.findAllByProductId(PRODUCT_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(imageRepoFindAllByProductId).not.toHaveBeenCalled();
    });
  });

  describe('findOne', () => {
    it('returns the image', async () => {
      imageRepoFindByIdAndProductId.mockResolvedValue(buildImage());

      const result = await service.findOne(PRODUCT_ID, IMAGE_ID);

      expect(result.id).toBe(IMAGE_ID);
      expect(imageRepoFindByIdAndProductId).toHaveBeenCalledWith(
        IMAGE_ID,
        PRODUCT_ID,
      );
    });

    it('missing image → 404', async () => {
      imageRepoFindByIdAndProductId.mockResolvedValue(null);

      await expect(
        service.findOne(PRODUCT_ID, IMAGE_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('wrong product ownership → 404, without revealing that the image exists', async () => {
      imageRepoFindByIdAndProductId.mockResolvedValue(null);

      const wrongProduct = await service
        .findOne(OTHER_PRODUCT_ID, IMAGE_ID)
        .catch((error: unknown) => error);

      expect(wrongProduct).toBeInstanceOf(NotFoundException);
      expect((wrongProduct as NotFoundException).message).toBe(
        `Product image ${IMAGE_ID} does not exist`,
      );
    });
  });

  describe('update', () => {
    it('updates imageUrl', async () => {
      const next = 'https://res.cloudinary.com/demo/image/upload/products/test/v2.jpg';
      imageRepoFindByIdAndProductId.mockResolvedValue(buildImage());
      imageRepoUpdate.mockResolvedValue(buildImage({ imageUrl: next }));

      const result = await service.update(
        PRODUCT_ID,
        IMAGE_ID,
        buildUpdateDto({ imageUrl: next }),
      );

      expect(imageRepoUpdate).toHaveBeenCalledWith(IMAGE_ID, {
        imageUrl: next,
      });
      expect(result.imageUrl).toBe(next);
    });

    it('updates publicId', async () => {
      imageRepoFindByIdAndProductId.mockResolvedValue(buildImage());
      imageRepoUpdate.mockResolvedValue(
        buildImage({ publicId: 'products/test/back' }),
      );

      const result = await service.update(
        PRODUCT_ID,
        IMAGE_ID,
        buildUpdateDto({ publicId: '  products/test/back  ' }),
      );

      expect(imageRepoUpdate).toHaveBeenCalledWith(IMAGE_ID, {
        publicId: 'products/test/back',
      });
      expect(result.publicId).toBe('products/test/back');
    });

    it('updates altText', async () => {
      imageRepoFindByIdAndProductId.mockResolvedValue(buildImage());
      imageRepoUpdate.mockResolvedValue(buildImage({ altText: 'Back' }));

      const result = await service.update(
        PRODUCT_ID,
        IMAGE_ID,
        buildUpdateDto({ altText: 'Back' }),
      );

      expect(imageRepoUpdate).toHaveBeenCalledWith(IMAGE_ID, {
        altText: 'Back',
      });
      expect(result.altText).toBe('Back');
    });

    it('clears altText when explicitly set to null', async () => {
      imageRepoFindByIdAndProductId.mockResolvedValue(buildImage());
      imageRepoUpdate.mockResolvedValue(buildImage({ altText: null }));

      const result = await service.update(
        PRODUCT_ID,
        IMAGE_ID,
        buildUpdateDto({ altText: null }),
      );

      expect(imageRepoUpdate).toHaveBeenCalledWith(IMAGE_ID, { altText: null });
      expect(result.altText).toBeNull();
    });

    it('updates sortOrder', async () => {
      imageRepoFindByIdAndProductId.mockResolvedValue(buildImage());
      imageRepoUpdate.mockResolvedValue(buildImage({ sortOrder: 3 }));

      const result = await service.update(
        PRODUCT_ID,
        IMAGE_ID,
        buildUpdateDto({ sortOrder: 3 }),
      );

      expect(imageRepoUpdate).toHaveBeenCalledWith(IMAGE_ID, { sortOrder: 3 });
      expect(result.sortOrder).toBe(3);
    });

    it('promotes a non-primary image through the transactional path', async () => {
      imageRepoFindByIdAndProductId.mockResolvedValue(buildImage({ isPrimary: false }));
      imageRepoUpdateAsPrimary.mockResolvedValue(buildImage({ isPrimary: true }));

      const result = await service.update(
        PRODUCT_ID,
        IMAGE_ID,
        buildUpdateDto({ isPrimary: true }),
      );

      expect(imageRepoUpdateAsPrimary).toHaveBeenCalledWith(IMAGE_ID, PRODUCT_ID, {});
      expect(imageRepoUpdate).not.toHaveBeenCalled();
      expect(result.isPrimary).toBe(true);
    });

    it('promotion carries the other columns in the same transaction', async () => {
      imageRepoFindByIdAndProductId.mockResolvedValue(buildImage({ isPrimary: false }));
      imageRepoUpdateAsPrimary.mockResolvedValue(
        buildImage({ isPrimary: true, altText: 'Back', sortOrder: 2 }),
      );

      const result = await service.update(
        PRODUCT_ID,
        IMAGE_ID,
        buildUpdateDto({ isPrimary: true, altText: 'Back', sortOrder: 2 }),
      );

      expect(imageRepoUpdateAsPrimary).toHaveBeenCalledWith(IMAGE_ID, PRODUCT_ID, {
        altText: 'Back',
        sortOrder: 2,
      });
      expect(result).toMatchObject({ isPrimary: true, altText: 'Back', sortOrder: 2 });
    });

    it('demoting an image that is already not primary performs no write', async () => {
      imageRepoFindByIdAndProductId.mockResolvedValue(buildImage({ isPrimary: false }));

      const result = await service.update(
        PRODUCT_ID,
        IMAGE_ID,
        buildUpdateDto({ isPrimary: false }),
      );

      expect(imageRepoUpdate).not.toHaveBeenCalled();
      expect(result.isPrimary).toBe(false);
    });

    it('re-promoting an image that is already primary performs no write', async () => {
      imageRepoFindByIdAndProductId.mockResolvedValue(buildImage({ isPrimary: true }));

      const result = await service.update(
        PRODUCT_ID,
        IMAGE_ID,
        buildUpdateDto({ isPrimary: true }),
      );

      expect(imageRepoUpdate).not.toHaveBeenCalled();
      expect(imageRepoUpdateAsPrimary).not.toHaveBeenCalled();
      expect(result.isPrimary).toBe(true);
    });

    it('cannot unset the only primary image → 409', async () => {
      const image = buildImage({ isPrimary: true });
      imageRepoFindByIdAndProductId.mockResolvedValue(image);
      imageRepoFindPrimaryByProductId.mockResolvedValue(image);

      await expect(
        service.update(PRODUCT_ID, IMAGE_ID, buildUpdateDto({ isPrimary: false })),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(imageRepoUpdate).not.toHaveBeenCalled();
    });

    it('allows the demotion once another image has taken over as primary', async () => {
      imageRepoFindByIdAndProductId.mockResolvedValue(buildImage({ isPrimary: true }));
      imageRepoFindPrimaryByProductId.mockResolvedValue(
        buildImage({ id: 'other-image', isPrimary: true }),
      );
      imageRepoUpdate.mockResolvedValue(buildImage({ isPrimary: false }));

      const result = await service.update(
        PRODUCT_ID,
        IMAGE_ID,
        buildUpdateDto({ isPrimary: false }),
      );

      expect(result.isPrimary).toBe(false);
    });

    it('wrong product ownership → 404', async () => {
      imageRepoFindByIdAndProductId.mockResolvedValue(null);

      await expect(
        service.update(OTHER_PRODUCT_ID, IMAGE_ID, buildUpdateDto({ altText: 'x' })),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(imageRepoUpdate).not.toHaveBeenCalled();
    });

    it('missing image → 404', async () => {
      imageRepoFindByIdAndProductId.mockResolvedValue(null);

      await expect(
        service.update(PRODUCT_ID, IMAGE_ID, buildUpdateDto({ altText: 'x' })),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('database errors propagate untouched', async () => {
      imageRepoFindByIdAndProductId.mockResolvedValue(buildImage());
      imageRepoUpdate.mockRejectedValue(new Error('deadlock detected'));

      await expect(
        service.update(PRODUCT_ID, IMAGE_ID, buildUpdateDto({ altText: 'x' })),
      ).rejects.toThrow('deadlock detected');
    });
  });

  describe('remove', () => {
    it('deletes a non-primary image', async () => {
      imageRepoFindByIdAndProductId.mockResolvedValue(buildImage({ isPrimary: false }));
      imageRepoDelete.mockResolvedValue(buildImage({ isPrimary: false }));

      await expect(service.remove(PRODUCT_ID, IMAGE_ID)).resolves.toBeUndefined();

      expect(imageRepoDelete).toHaveBeenCalledWith(IMAGE_ID);
    });

    it('deleting the primary image → 409', async () => {
      imageRepoFindByIdAndProductId.mockResolvedValue(buildImage({ isPrimary: true }));

      await expect(
        service.remove(PRODUCT_ID, IMAGE_ID),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(imageRepoDelete).not.toHaveBeenCalled();
    });

    it('missing image → 404', async () => {
      imageRepoFindByIdAndProductId.mockResolvedValue(null);

      await expect(service.remove(PRODUCT_ID, IMAGE_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(imageRepoDelete).not.toHaveBeenCalled();
    });

    it('wrong product ownership → 404', async () => {
      imageRepoFindByIdAndProductId.mockResolvedValue(null);

      await expect(
        service.remove(OTHER_PRODUCT_ID, IMAGE_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(imageRepoDelete).not.toHaveBeenCalled();
    });

    it('database errors propagate untouched', async () => {
      imageRepoFindByIdAndProductId.mockResolvedValue(buildImage({ isPrimary: false }));
      imageRepoDelete.mockRejectedValue(new Error('connection terminated'));

      await expect(service.remove(PRODUCT_ID, IMAGE_ID)).rejects.toThrow(
        'connection terminated',
      );
    });

    describe('Cloudinary integration', () => {
      beforeEach(() => {
        imageRepoFindByIdAndProductId.mockResolvedValue(
          buildImage({ isPrimary: false }),
        );
        imageRepoDelete.mockResolvedValue(buildImage({ isPrimary: false }));
      });

      it('deletes the asset using the publicId stored on the row', async () => {
        await service.remove(PRODUCT_ID, IMAGE_ID);

        expect(cloudinaryDeleteAsset).toHaveBeenCalledWith(PUBLIC_ID);
      });

      it('uses the stored publicId, not one derived from the image id', async () => {
        /**
         * The delete handle is whatever Cloudinary returned at upload time. It is
         * stored on the row precisely because it cannot be reconstructed later, so
         * this pins the source of the value.
         */
        imageRepoFindByIdAndProductId.mockResolvedValue(
          buildImage({ id: IMAGE_ID, publicId: CLOUDINARY_PUBLIC_ID }),
        );

        await service.remove(PRODUCT_ID, IMAGE_ID);

        expect(cloudinaryDeleteAsset).toHaveBeenCalledWith(CLOUDINARY_PUBLIC_ID);
      });

      it('deletes the Cloudinary asset before the database row', async () => {
        /**
         * Order is the design: the row is the only record of the publicId, so
         * removing it first would strand the asset with nothing able to find it.
         */
        const order: string[] = [];

        cloudinaryDeleteAsset.mockImplementation(async () => {
          order.push('cloudinary');

          return true;
        });
        imageRepoDelete.mockImplementation(async () => {
          order.push('database');

          return buildImage();
        });

        await service.remove(PRODUCT_ID, IMAGE_ID);

        expect(order).toEqual(['cloudinary', 'database']);
      });

      it('Cloudinary failure → 500 and the row is left untouched', async () => {
        /**
         * The rejection mirrors what `CloudinaryService` actually throws: it has
         * already mapped the upstream failure to a 500, and the service
         * deliberately does not re-wrap it.
         */
        cloudinaryDeleteAsset.mockRejectedValue(
          new InternalServerErrorException('Image deletion failed: Invalid API key'),
        );

        await expect(
          service.remove(PRODUCT_ID, IMAGE_ID),
        ).rejects.toBeInstanceOf(InternalServerErrorException);
        expect(imageRepoDelete).not.toHaveBeenCalled();
      });

      it('Cloudinary failure keeps the row so the delete can be retried', async () => {
        cloudinaryDeleteAsset.mockRejectedValue(new Error('upstream timeout'));

        await expect(service.remove(PRODUCT_ID, IMAGE_ID)).rejects.toThrow();

        /**
         * Nothing was written, so the stored publicId survives and a retry still
         * knows which asset to destroy.
         */
        expect(imageRepoUpdate).not.toHaveBeenCalled();
        expect(imageRepoDelete).not.toHaveBeenCalled();
      });

      it('does not touch Cloudinary when the image is not found', async () => {
        imageRepoFindByIdAndProductId.mockResolvedValue(null);

        await expect(service.remove(PRODUCT_ID, IMAGE_ID)).rejects.toBeInstanceOf(
          NotFoundException,
        );
        expect(cloudinaryDeleteAsset).not.toHaveBeenCalled();
      });

      it('does not touch Cloudinary when the image belongs to another product', async () => {
        imageRepoFindByIdAndProductId.mockResolvedValue(null);

        await expect(
          service.remove(OTHER_PRODUCT_ID, IMAGE_ID),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(cloudinaryDeleteAsset).not.toHaveBeenCalled();
      });

      it('primary image → 409 and Cloudinary is never called', async () => {
        imageRepoFindByIdAndProductId.mockResolvedValue(
          buildImage({ isPrimary: true }),
        );

        await expect(
          service.remove(PRODUCT_ID, IMAGE_ID),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(cloudinaryDeleteAsset).not.toHaveBeenCalled();
        expect(imageRepoDelete).not.toHaveBeenCalled();
      });

      it('a failed row delete leaves the asset already gone', async () => {
        /**
         * The accepted residual risk of this ordering, asserted so it stays a
         * conscious decision: the row survives pointing at a deleted asset, which
         * is visible and repairable. The reverse order would leak the asset with no
         * trace at all.
         */
        imageRepoDelete.mockRejectedValue(new Error('connection terminated'));

        await expect(service.remove(PRODUCT_ID, IMAGE_ID)).rejects.toThrow(
          'connection terminated',
        );
        expect(cloudinaryDeleteAsset).toHaveBeenCalledWith(PUBLIC_ID);
      });
    });
  });

  describe('upload', () => {
    beforeEach(() => {
      imageRepoCreate.mockImplementation((data: Record<string, unknown>) =>
        Promise.resolve(buildImage(data)),
      );
      imageRepoCreateAsPrimary.mockImplementation((data: Record<string, unknown>) =>
        Promise.resolve(buildImage(data)),
      );
    });

    it('uploads a valid image file', async () => {
      const result = await service.upload(PRODUCT_ID, buildUploadedFile());

      expect(result).toBeDefined();
      expect(cloudinaryUpload).toHaveBeenCalledTimes(1);
      expect(imageRepoCreate).toHaveBeenCalledTimes(1);
    });

    it('passes the file buffer and MIME type to Cloudinary', async () => {
      await service.upload(PRODUCT_ID, buildUploadedFile());

      expect(cloudinaryUpload).toHaveBeenCalledWith({
        buffer: PNG_BYTES,
        mimeType: 'image/png',
      });
    });

    it('stores imageUrl and publicId taken from the Cloudinary result', async () => {
      await service.upload(PRODUCT_ID, buildUploadedFile());

      expect(imageRepoCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          imageUrl: CLOUDINARY_SECURE_URL,
          publicId: CLOUDINARY_PUBLIC_ID,
        }),
      );
    });

    it('never stores the client-declared filename as the publicId', async () => {
      await service.upload(
        PRODUCT_ID,
        buildUploadedFile({ originalname: 'evil-attacker-path.png' }),
      );

      expect(imageRepoCreate).not.toHaveBeenCalledWith(
        expect.objectContaining({ publicId: 'evil-attacker-path.png' }),
      );
    });

    it('ignores any imageUrl or publicId smuggled into the DTO', async () => {
      /**
       * The upload DTO does not declare these fields, so they cannot reach the
       * service through HTTP — `forbidNonWhitelisted` rejects them at the pipe. This
       * test proves the guarantee does not rest on that alone: even if a caller
       * passes them, they are not copied into the row.
       */
      await service.upload(
        PRODUCT_ID,
        buildUploadedFile(),
        Object.assign(buildUploadDto(), {
          imageUrl: 'https://attacker.example/evil.png',
          publicId: 'attacker/evil',
        }) as UploadProductImageDto,
      );

      expect(imageRepoCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          imageUrl: CLOUDINARY_SECURE_URL,
          publicId: CLOUDINARY_PUBLIC_ID,
        }),
      );
    });

    it('applies default sortOrder and isPrimary', async () => {
      await service.upload(PRODUCT_ID, buildUploadedFile());

      expect(imageRepoCreate).toHaveBeenCalledWith(
        expect.objectContaining({ sortOrder: 0, isPrimary: false }),
      );
    });

    it('honours an explicit sortOrder', async () => {
      await service.upload(
        PRODUCT_ID,
        buildUploadedFile(),
        buildUploadDto({ sortOrder: 3 }),
      );

      expect(imageRepoCreate).toHaveBeenCalledWith(
        expect.objectContaining({ sortOrder: 3 }),
      );
    });

    it('normalises altText and defaults it to null', async () => {
      await service.upload(
        PRODUCT_ID,
        buildUploadedFile(),
        buildUploadDto({ altText: '  Front view  ' }),
      );

      expect(imageRepoCreate).toHaveBeenCalledWith(
        expect.objectContaining({ altText: 'Front view' }),
      );

      await service.upload(PRODUCT_ID, buildUploadedFile());

      expect(imageRepoCreate).toHaveBeenLastCalledWith(
        expect.objectContaining({ altText: null }),
      );
    });

    it('isPrimary: true goes through the transactional create path', async () => {
      await service.upload(
        PRODUCT_ID,
        buildUploadedFile(),
        buildUploadDto({ isPrimary: true }),
      );

      expect(imageRepoCreateAsPrimary).toHaveBeenCalledWith(
        expect.objectContaining({ isPrimary: true }),
      );
      expect(imageRepoCreate).not.toHaveBeenCalled();
    });

    it('isPrimary: false uses the ordinary create path', async () => {
      await service.upload(
        PRODUCT_ID,
        buildUploadedFile(),
        buildUploadDto({ isPrimary: false }),
      );

      expect(imageRepoCreate).toHaveBeenCalledWith(
        expect.objectContaining({ isPrimary: false }),
      );
      expect(imageRepoCreateAsPrimary).not.toHaveBeenCalled();
    });

    it('uploads before inserting the row', async () => {
      const order: string[] = [];

      cloudinaryUpload.mockImplementation(async () => {
        order.push('cloudinary');

        return buildCloudinaryUploadResult();
      });
      imageRepoCreate.mockImplementation(async (data: Record<string, unknown>) => {
        order.push('database');

        return buildImage(data);
      });

      await service.upload(PRODUCT_ID, buildUploadedFile());

      expect(order).toEqual(['cloudinary', 'database']);
    });

    describe('rejected before Cloudinary is called', () => {
      it('nonexistent product → 404 and no upload', async () => {
        productRepoFindById.mockResolvedValue(null);

        await expect(
          service.upload(PRODUCT_ID, buildUploadedFile()),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(cloudinaryUpload).not.toHaveBeenCalled();
      });

      it('missing file → 400 and no upload', async () => {
        await expect(service.upload(PRODUCT_ID, undefined)).rejects.toBeInstanceOf(
          BadRequestException,
        );
        expect(cloudinaryUpload).not.toHaveBeenCalled();
      });

      it('empty file → 400 and no upload', async () => {
        await expect(
          service.upload(PRODUCT_ID, buildUploadedFile({ buffer: Buffer.alloc(0) })),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(cloudinaryUpload).not.toHaveBeenCalled();
      });

      it('a part with no buffer at all → 400 and no upload', async () => {
        await expect(
          service.upload(
            PRODUCT_ID,
            buildUploadedFile({ buffer: undefined as unknown as Buffer }),
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(cloudinaryUpload).not.toHaveBeenCalled();
      });

      it('oversized file → 400 propagates and no row is inserted', async () => {
        /**
         * The limit itself is `CloudinaryService`'s to enforce and is exhaustively
         * tested there; what matters here is that the service delegates rather than
         * uploading first and validating later, so a rejection stops the insert.
         */
        cloudinaryUpload.mockRejectedValue(
          new BadRequestException('Image file exceeds the maximum size'),
        );

        await expect(
          service.upload(
            PRODUCT_ID,
            buildUploadedFile({
              buffer: Buffer.alloc(CLOUDINARY_MAX_FILE_SIZE_BYTES + 1, 0x41),
            }),
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(imageRepoCreate).not.toHaveBeenCalled();
      });

      it('invalid MIME type → 400 propagates and no row is inserted', async () => {
        cloudinaryUpload.mockRejectedValue(
          new BadRequestException('Unsupported image type'),
        );

        await expect(
          service.upload(
            PRODUCT_ID,
            buildUploadedFile({ mimetype: 'application/pdf' }),
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(imageRepoCreate).not.toHaveBeenCalled();
      });
    });

    describe('Cloudinary failure', () => {
      it('propagates a 500 and inserts nothing', async () => {
        cloudinaryUpload.mockRejectedValue(
          new InternalServerErrorException('Image upload failed: Invalid API key'),
        );

        await expect(
          service.upload(PRODUCT_ID, buildUploadedFile()),
        ).rejects.toBeInstanceOf(InternalServerErrorException);
        expect(imageRepoCreate).not.toHaveBeenCalled();
        expect(imageRepoCreateAsPrimary).not.toHaveBeenCalled();
      });

      it('does not compensate, because no asset was created', async () => {
        cloudinaryUpload.mockRejectedValue(new Error('upload refused'));

        await expect(service.upload(PRODUCT_ID, buildUploadedFile())).rejects.toThrow();

        expect(cloudinaryDeleteAsset).not.toHaveBeenCalled();
      });
    });

    describe('database failure → Cloudinary compensation', () => {
      it('deletes the uploaded asset when the insert fails', async () => {
        imageRepoCreate.mockRejectedValue(new Error('unique constraint failed'));

        await expect(service.upload(PRODUCT_ID, buildUploadedFile())).rejects.toThrow(
          'unique constraint failed',
        );
        expect(cloudinaryDeleteAsset).toHaveBeenCalledWith(CLOUDINARY_PUBLIC_ID);
      });

      it('compensates on the isPrimary path too', async () => {
        imageRepoCreateAsPrimary.mockRejectedValue(
          new Error('partial unique index violated'),
        );

        await expect(
          service.upload(
            PRODUCT_ID,
            buildUploadedFile(),
            buildUploadDto({ isPrimary: true }),
          ),
        ).rejects.toThrow('partial unique index violated');
        expect(cloudinaryDeleteAsset).toHaveBeenCalledWith(CLOUDINARY_PUBLIC_ID);
      });

      it('surfaces the database error, not the cleanup outcome', async () => {
        imageRepoCreate.mockRejectedValue(new Error('deadlock detected'));

        await expect(service.upload(PRODUCT_ID, buildUploadedFile())).rejects.toThrow(
          'deadlock detected',
        );
      });

      it('a failed compensation still reports the original database error', async () => {
        /**
         * Reporting "cleanup failed" would hide the real fault and send an operator
         * looking in the wrong place, so the compensation error is logged and
         * swallowed.
         */
        imageRepoCreate.mockRejectedValue(new Error('connection terminated'));
        cloudinaryDeleteAsset.mockRejectedValue(new Error('cloudinary unreachable'));

        await expect(service.upload(PRODUCT_ID, buildUploadedFile())).rejects.toThrow(
          'connection terminated',
        );
      });

      it('compensates exactly once', async () => {
        imageRepoCreate.mockRejectedValue(new Error('insert failed'));

        await expect(service.upload(PRODUCT_ID, buildUploadedFile())).rejects.toThrow();

        expect(cloudinaryDeleteAsset).toHaveBeenCalledTimes(1);
      });

      it('a successful insert performs no compensation', async () => {
        await service.upload(PRODUCT_ID, buildUploadedFile());

        expect(cloudinaryDeleteAsset).not.toHaveBeenCalled();
      });
    });
  });
});

/**
 * Wires the **real** `CloudinaryService` into `ProductImagesService`, with only the
 * SDK client stubbed.
 *
 * The rest of the suite mocks `CloudinaryService` wholesale, which is right for
 * testing this feature's own rules but cannot prove anything about the *real*
 * validation gate — a mock returns whatever the test tells it to. These cases exist
 * to close that gap: a rejected file must never reach the SDK, and that is only
 * observable when the code doing the rejecting is the production one.
 */
describe('ProductImagesService with the real CloudinaryService', () => {
  const uploadStream = vi.fn();
  const destroy = vi.fn();
  let service: ProductImagesService;
  let imageRepoCreate: ReturnType<typeof vi.fn>;
  let productRepoFindById: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    uploadStream.mockReset();
    destroy.mockReset();
    imageRepoCreate = vi.fn().mockImplementation((data: Record<string, unknown>) =>
      Promise.resolve(buildImage(data)),
    );
    productRepoFindById = vi.fn().mockResolvedValue(buildProduct());

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductImagesService,
        {
          provide: ProductImagesRepository,
          useValue: {
            create: imageRepoCreate,
            createAsPrimary: vi.fn(),
            findByIdAndProductId: vi.fn(),
            findPrimaryByProductId: vi.fn(),
            findAllByProductId: vi.fn(),
            update: vi.fn(),
            updateAsPrimary: vi.fn(),
            delete: vi.fn(),
          },
        },
        { provide: ProductsRepository, useValue: { findById: productRepoFindById } },
        CloudinaryService,
        {
          provide: CLOUDINARY_CLIENT,
          useValue: { uploader: { upload_stream: uploadStream, destroy } },
        },
        { provide: CLOUDINARY_CREDENTIALS, useValue: TEST_CREDENTIALS },
      ],
    }).compile();

    service = module.get<ProductImagesService>(ProductImagesService);
  });

  it.each([
    ['a PDF', 'application/pdf'],
    ['plain text', 'text/plain'],
    ['a video', 'video/mp4'],
    ['SVG, which is scriptable', 'image/svg+xml'],
  ])('rejects %s without reaching the SDK', async (_label, mimeType) => {
    await expect(
      service.upload(PRODUCT_ID, buildUploadedFile({ mimetype: mimeType })),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(uploadStream).not.toHaveBeenCalled();
    expect(imageRepoCreate).not.toHaveBeenCalled();
  });

  it('rejects a file over the size limit without reaching the SDK', async () => {
    await expect(
      service.upload(
        PRODUCT_ID,
        buildUploadedFile({
          buffer: Buffer.alloc(CLOUDINARY_MAX_FILE_SIZE_BYTES + 1, 0x41),
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(uploadStream).not.toHaveBeenCalled();
    expect(imageRepoCreate).not.toHaveBeenCalled();
  });

  it('uploads a valid file and records the SDK-returned publicId', async () => {
    uploadStream.mockImplementation(
      (
        _options: unknown,
        callback: (error: unknown, result: unknown) => void,
      ) => {
        callback(null, {
          secure_url: CLOUDINARY_SECURE_URL,
          public_id: CLOUDINARY_PUBLIC_ID,
          width: 1200,
          height: 1600,
          format: 'png',
          bytes: PNG_BYTES.length,
        });

        return { end: vi.fn(), once: vi.fn() };
      },
    );

    await service.upload(PRODUCT_ID, buildUploadedFile());

    expect(uploadStream).toHaveBeenCalledTimes(1);
    expect(imageRepoCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        imageUrl: CLOUDINARY_SECURE_URL,
        publicId: CLOUDINARY_PUBLIC_ID,
      }),
    );
  });
});
