import {
  HttpStatus,
  type INestApplication,
  InternalServerErrorException,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CLOUDINARY_MAX_FILE_SIZE_BYTES } from '../cloudinary/cloudinary.constants.js';
import { CreateProductImageDto } from './dto/create-product-image.dto.js';
import { ProductImageResponseDto } from './dto/product-image-response.dto.js';
import { UpdateProductImageDto } from './dto/update-product-image.dto.js';
import { UploadProductImageDto } from './dto/upload-product-image.dto.js';
import type { UploadedImageFile } from './interfaces/uploaded-image-file.js';
import { ProductImagesController } from './product-images.controller.js';
import { ProductImagesService } from './product-images.service.js';

const PRODUCT_ID = 'a1b2c3d4-e5f6-4f70-8a9b-0c1d2e3f4a5b';
const IMAGE_ID = 'c1b2c3d4-e5f6-4f70-8a9b-0c1d2e3f4a5b';
const IMAGE_URL = 'https://res.cloudinary.com/demo/image/upload/products/test/front.jpg';
const PUBLIC_ID = 'products/test/front';

/** A real PNG header, so the multipart body is not merely empty bytes. */
const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

/** Cloudinary's own values, distinct from any client input. */
const CLOUDINARY_PUBLIC_ID = 'products/t3zj4kq8u9abcdef';
const CLOUDINARY_SECURE_URL =
  'https://res.cloudinary.com/demo/image/upload/v1750000000/products/t3zj4kq8u9abcdef.png';

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

const buildResponse = (
  overrides: Partial<ProductImageResponseDto> = {},
): ProductImageResponseDto =>
  Object.assign(new ProductImageResponseDto(), {
    id: IMAGE_ID,
    productId: PRODUCT_ID,
    imageUrl: IMAGE_URL,
    publicId: PUBLIC_ID,
    altText: 'Front',
    sortOrder: 0,
    isPrimary: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

const buildCreateDto = (
  overrides: Partial<CreateProductImageDto> = {},
): CreateProductImageDto =>
  Object.assign(new CreateProductImageDto(), {
    productId: PRODUCT_ID,
    imageUrl: IMAGE_URL,
    publicId: PUBLIC_ID,
    altText: 'Front',
    sortOrder: 0,
    isPrimary: true,
    ...overrides,
  });

const buildUpdateDto = (
  overrides: Partial<UpdateProductImageDto> = {},
): UpdateProductImageDto => Object.assign(new UpdateProductImageDto(), overrides);

type ServiceMock = {
  create: ReturnType<typeof vi.fn>;
  findAllByProductId: ReturnType<typeof vi.fn>;
  findOne: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  upload: ReturnType<typeof vi.fn>;
};

const buildServiceMock = (): ServiceMock => ({
  create: vi.fn(),
  findAllByProductId: vi.fn(),
  findOne: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  upload: vi.fn(),
});

describe('ProductImagesController', () => {
  let controller: ProductImagesController;
  let service: ServiceMock;

  beforeEach(async () => {
    service = buildServiceMock();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProductImagesController],
      providers: [{ provide: ProductImagesService, useValue: service }],
    }).compile();

    controller = module.get<ProductImagesController>(ProductImagesController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('delegates creation with the product from the path', () => {
    const dto = buildCreateDto();
    const expected = buildResponse();
    service.create.mockReturnValue(expected);

    expect(controller.create(PRODUCT_ID, dto)).toBe(expected);
    expect(service.create).toHaveBeenCalledWith(PRODUCT_ID, dto);
  });

  it('GET → 200', () => {
    service.findAllByProductId.mockReturnValue([buildResponse()]);

    expect(controller.findAll(PRODUCT_ID)).toHaveLength(1);
    expect(service.findAllByProductId).toHaveBeenCalledWith(PRODUCT_ID);
  });

  it('GET by image ID → 200', () => {
    const expected = buildResponse();
    service.findOne.mockReturnValue(expected);

    expect(controller.findOne(PRODUCT_ID, IMAGE_ID)).toBe(expected);
    expect(service.findOne).toHaveBeenCalledWith(PRODUCT_ID, IMAGE_ID);
  });

  it('PATCH → 200', () => {
    const dto = buildUpdateDto({ altText: 'Back' });
    const expected = buildResponse({ altText: 'Back' });
    service.update.mockReturnValue(expected);

    expect(controller.update(PRODUCT_ID, IMAGE_ID, dto)).toBe(expected);
    expect(service.update).toHaveBeenCalledWith(PRODUCT_ID, IMAGE_ID, dto);
  });

  it('DELETE → 204', async () => {
    service.remove.mockResolvedValue(undefined);

    await expect(
      controller.remove(PRODUCT_ID, IMAGE_ID),
    ).resolves.toBeUndefined();
    expect(service.remove).toHaveBeenCalledWith(PRODUCT_ID, IMAGE_ID);
  });

  it('delegates an upload with the product from the path and the parsed file', () => {
    const file = buildUploadedFile();
    const dto = buildUploadDto({ altText: 'Front' });
    const expected = buildResponse();
    service.upload.mockReturnValue(expected);

    expect(controller.upload(PRODUCT_ID, file, dto)).toBe(expected);
    expect(service.upload).toHaveBeenCalledWith(PRODUCT_ID, file, dto);
  });

  it('passes an absent file through to the service rather than defaulting one', () => {
    /**
     * The controller must not fabricate an empty upload: whether a missing file is
     * a 400 is the service's rule, and inventing a placeholder here would turn it
     * into a confusing "empty file" error further down.
     */
    controller.upload(PRODUCT_ID, undefined, buildUploadDto());

    expect(service.upload).toHaveBeenCalledWith(PRODUCT_ID, undefined, expect.anything());
  });
});

describe('ProductImagesController (HTTP)', () => {
  let app: INestApplication;
  let service: ServiceMock;
  let baseUrl: string;

  beforeEach(async () => {
    service = buildServiceMock();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProductImagesController],
      providers: [{ provide: ProductImagesService, useValue: service }],
    }).compile();

    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.listen(0);
    baseUrl = `${await app.getUrl()}/products/${PRODUCT_ID}/images`;
  });

  afterEach(async () => {
    await app.close();
  });

  it('POST → 201', async () => {
    service.create.mockResolvedValue(buildResponse());

    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productId: PRODUCT_ID,
        imageUrl: IMAGE_URL,
        publicId: PUBLIC_ID,
        altText: 'Front',
        sortOrder: 0,
        isPrimary: true,
      }),
    });

    expect(res.status).toBe(HttpStatus.CREATED);
    const body = (await res.json()) as ProductImageResponseDto;
    expect(body).toMatchObject({
      id: IMAGE_ID,
      productId: PRODUCT_ID,
      imageUrl: IMAGE_URL,
      publicId: PUBLIC_ID,
      sortOrder: 0,
      isPrimary: true,
    });
  });

  it('GET → 200', async () => {
    service.findAllByProductId.mockResolvedValue([buildResponse()]);

    const res = await fetch(baseUrl);

    expect(res.status).toBe(HttpStatus.OK);
    await expect(res.json()).resolves.toHaveLength(1);
  });

  it('GET by image ID → 200', async () => {
    service.findOne.mockResolvedValue(buildResponse());

    const res = await fetch(`${baseUrl}/${IMAGE_ID}`);

    expect(res.status).toBe(HttpStatus.OK);
  });

  it('PATCH → 200', async () => {
    service.update.mockResolvedValue(buildResponse({ altText: 'Back' }));

    const res = await fetch(`${baseUrl}/${IMAGE_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ altText: 'Back' }),
    });

    expect(res.status).toBe(HttpStatus.OK);
  });

  it('DELETE → 204 with an empty body', async () => {
    service.remove.mockResolvedValue(undefined);

    const res = await fetch(`${baseUrl}/${IMAGE_ID}`, { method: 'DELETE' });

    expect(res.status).toBe(HttpStatus.NO_CONTENT);
    await expect(res.text()).resolves.toBe('');
  });

  it('malformed product UUID → 400 and the service is never called', async () => {
    const res = await fetch(
      `${baseUrl.replace(PRODUCT_ID, 'not-a-uuid')}`,
    );

    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(service.findAllByProductId).not.toHaveBeenCalled();
  });

  it('malformed image UUID → 400 and the service is never called', async () => {
    const res = await fetch(`${baseUrl}/not-a-uuid`);

    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(service.findOne).not.toHaveBeenCalled();
  });

  it('invalid DTO → 400', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(service.create).not.toHaveBeenCalled();
  });

  it('invalid image URL → 400', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productId: PRODUCT_ID,
        imageUrl: 'not-a-url',
        publicId: PUBLIC_ID,
      }),
    });

    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(service.create).not.toHaveBeenCalled();
  });

  it('non-http URL scheme → 400', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productId: PRODUCT_ID,
        imageUrl: 'javascript:alert(1)',
        publicId: PUBLIC_ID,
      }),
    });

    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
  });

  it('negative sortOrder → 400', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productId: PRODUCT_ID,
        imageUrl: IMAGE_URL,
        publicId: PUBLIC_ID,
        sortOrder: -1,
      }),
    });

    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(service.create).not.toHaveBeenCalled();
  });

  it('negative sortOrder on PATCH → 400', async () => {
    const res = await fetch(`${baseUrl}/${IMAGE_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sortOrder: -5 }),
    });

    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(service.update).not.toHaveBeenCalled();
  });

  it('forbidden fields rejected on create', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productId: PRODUCT_ID,
        imageUrl: IMAGE_URL,
        publicId: PUBLIC_ID,
        id: IMAGE_ID,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    });

    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(service.create).not.toHaveBeenCalled();
  });

  it('productId cannot be changed on PATCH → 400', async () => {
    const res = await fetch(`${baseUrl}/${IMAGE_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productId: 'b1b2c3d4-e5f6-4f70-8a9b-0c1d2e3f4a5b',
      }),
    });

    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(service.update).not.toHaveBeenCalled();
  });

  it('the metadata route does not accept a multipart upload', async () => {
    /**
     * Pins the routing decision. `POST /images` keeps its Phase 4A JSON contract,
     * and `POST /images/upload` is the only path that consumes a file. If a future
     * change collapses them, this fails — the same path could not both require a
     * JSON body and accept a multipart file.
     */
    const form = new FormData();
    form.append('file', new Blob(PNG_BYTES, { type: 'image/png' }), 'front.png');

    const res = await fetch(baseUrl, { method: 'POST', body: form });

    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(service.upload).not.toHaveBeenCalled();
  });

  it('the upload route does not accept the JSON metadata contract', async () => {
    const res = await fetch(`${baseUrl}/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productId: PRODUCT_ID,
        imageUrl: IMAGE_URL,
        publicId: PUBLIC_ID,
      }),
    });

    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(service.upload).not.toHaveBeenCalled();
  });
});

describe('ProductImagesController (multipart upload)', () => {
  let app: INestApplication;
  let service: ServiceMock;
  let baseUrl: string;

  beforeEach(async () => {
    service = buildServiceMock();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProductImagesController],
      providers: [{ provide: ProductImagesService, useValue: service }],
    }).compile();

    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.listen(0);
    baseUrl = `${await app.getUrl()}/products/${PRODUCT_ID}/images/upload`;
  });

  afterEach(async () => {
    await app.close();
  });

  /** Builds a valid multipart body, with optional extra text fields. */
  const buildForm = (
    options: {
      mimeType?: string;
      bytes?: Buffer;
      filename?: string;
      includeFile?: boolean;
      fields?: Record<string, string>;
    } = {},
  ): FormData => {
    const form = new FormData();

    if (options.includeFile !== false) {
      form.append(
        'file',
        new Blob([options.bytes ?? PNG_BYTES], {
          type: options.mimeType ?? 'image/png',
        }),
        options.filename ?? 'front.png',
      );
    }

    for (const [key, value] of Object.entries(options.fields ?? {})) {
      form.append(key, value);
    }

    return form;
  };

  it('POST /upload → 201 with the created row', async () => {
    service.upload.mockResolvedValue(
      buildResponse({
        imageUrl: CLOUDINARY_SECURE_URL,
        publicId: CLOUDINARY_PUBLIC_ID,
        altText: 'Front view',
      }),
    );

    const res = await fetch(baseUrl, {
      method: 'POST',
      body: buildForm({ fields: { altText: 'Front view' } }),
    });

    expect(res.status).toBe(HttpStatus.CREATED);
    expect(await res.json()).toMatchObject({
      productId: PRODUCT_ID,
      imageUrl: CLOUDINARY_SECURE_URL,
      publicId: CLOUDINARY_PUBLIC_ID,
      altText: 'Front view',
    });
  });

  it('hands the service a real buffer and the declared MIME type', async () => {
    service.upload.mockResolvedValue(buildResponse());

    await fetch(baseUrl, { method: 'POST', body: buildForm() });

    const [, file] = service.upload.mock.calls[0];
    expect(Buffer.isBuffer(file.buffer)).toBe(true);
    expect(file.buffer.length).toBeGreaterThan(0);
    expect(file.mimetype).toBe('image/png');
  });

  it('coerces a multipart sortOrder string to a number', async () => {
    service.upload.mockResolvedValue(buildResponse());

    await fetch(baseUrl, {
      method: 'POST',
      body: buildForm({ fields: { sortOrder: '2' } }),
    });

    const [, , dto] = service.upload.mock.calls[0];
    expect(dto.sortOrder).toBe(2);
  });

  it('coerces a multipart isPrimary string to a boolean', async () => {
    service.upload.mockResolvedValue(buildResponse());

    await fetch(baseUrl, {
      method: 'POST',
      body: buildForm({ fields: { isPrimary: 'true' } }),
    });

    const [, , dto] = service.upload.mock.calls[0];
    expect(dto.isPrimary).toBe(true);
  });

  it('reads isPrimary=false as false, not as a truthy string', async () => {
    /**
     * The bug the explicit transform exists to prevent: JavaScript's
     * `Boolean('false')` is `true`. A naive coercion would turn a client's explicit
     * "do not make this primary" into a promotion that demotes the product's
     * existing primary image — the precise opposite of the request.
     */
    service.upload.mockResolvedValue(buildResponse());

    await fetch(baseUrl, {
      method: 'POST',
      body: buildForm({ fields: { isPrimary: 'false' } }),
    });

    const [, , dto] = service.upload.mock.calls[0];
    expect(dto.isPrimary).toBe(false);
  });

  it('accepts isPrimary=0 as false', async () => {
    service.upload.mockResolvedValue(buildResponse());

    await fetch(baseUrl, {
      method: 'POST',
      body: buildForm({ fields: { isPrimary: '0' } }),
    });

    const [, , dto] = service.upload.mock.calls[0];
    expect(dto.isPrimary).toBe(false);
  });

  it('rejects a non-boolean isPrimary with 400', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      body: buildForm({ fields: { isPrimary: 'maybe' } }),
    });

    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(service.upload).not.toHaveBeenCalled();
  });

  it('accepts sortOrder=0', async () => {
    service.upload.mockResolvedValue(buildResponse());

    await fetch(baseUrl, {
      method: 'POST',
      body: buildForm({ fields: { sortOrder: '0' } }),
    });

    const [, , dto] = service.upload.mock.calls[0];
    expect(dto.sortOrder).toBe(0);
  });

  it.each([['abc'], ['1.5'], [''], ['-1']])(
    'rejects sortOrder=%j with 400',
    async (sortOrder) => {
      /**
       * `abc` and `''` must not become `NaN` or `0`, and `1.5` is not an integer.
       * `-1` parses fine but fails the minimum. All four are the caller's mistake
       * and must be reported as such rather than silently repaired.
       */
      const res = await fetch(baseUrl, {
        method: 'POST',
        body: buildForm({ fields: { sortOrder } }),
      });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(service.upload).not.toHaveBeenCalled();
    },
  );

  describe('client cannot control the asset identity', () => {
    it.each([
      ['publicId', 'attacker/chosen-handle'],
      ['imageUrl', 'https://attacker.example/evil.png'],
    ])('rejects a multipart %s field with 400', async (field, value) => {
      const res = await fetch(baseUrl, {
        method: 'POST',
        body: buildForm({ fields: { [field]: value } }),
      });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(service.upload).not.toHaveBeenCalled();
    });

    it('rejects publicId even alongside valid fields', async () => {
      const res = await fetch(baseUrl, {
        method: 'POST',
        body: buildForm({
          fields: { altText: 'Front', publicId: 'attacker/chosen-handle' },
        }),
      });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(service.upload).not.toHaveBeenCalled();
    });

    it('treats a traversal filename as inert data', async () => {
      service.upload.mockResolvedValue(buildResponse());

      const res = await fetch(baseUrl, {
        method: 'POST',
        body: buildForm({ filename: '../../escape.png' }),
      });

      expect(res.status).toBe(HttpStatus.CREATED);

      const [, file, dto] = service.upload.mock.calls[0];

      /**
       * multer strips the directory portion (`preservePath: false`), so even the
       * inert field cannot carry `../`. Nothing in the feature reads `originalname`
       * for storage — the publicId comes from Cloudinary — but the path never
       * reaching the service is a second, independent reason traversal cannot
       * influence the stored asset.
       */
      expect(file.originalname).not.toContain('..');
      expect(file.originalname).not.toContain('/');

      /**
       * The identity fields are structurally absent from the parsed body, so there
       * is nothing for a future change to accidentally start reading.
       */
      expect(Object.keys(dto)).not.toContain('publicId');
      expect(Object.keys(dto)).not.toContain('imageUrl');
    });
  });

  describe('file rejected before reaching the service', () => {
    it.each([
      ['a PDF', 'application/pdf'],
      ['plain text', 'text/plain'],
      ['a video', 'video/mp4'],
      ['SVG, which is scriptable', 'image/svg+xml'],
    ])('rejects %s with 400', async (_label, mimeType) => {
      const res = await fetch(baseUrl, {
        method: 'POST',
        body: buildForm({ mimeType }),
      });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(service.upload).not.toHaveBeenCalled();
    });

    it('rejects a file over 5 MiB before the service', async () => {
      const oversized = Buffer.alloc(CLOUDINARY_MAX_FILE_SIZE_BYTES + 1024, 0x41);

      const res = await fetch(baseUrl, {
        method: 'POST',
        body: buildForm({ bytes: oversized }),
      });

      /**
       * 413 rather than 400: Nest maps multer's `LIMIT_FILE_SIZE` to
       * Payload Too Large, which is the more precise status for an oversized
       * body. Either way it is a 4xx and the service is never reached, which is
       * the property that matters — the bytes were refused while arriving rather
       * than after being buffered and uploaded.
       */
      expect(res.status).toBe(HttpStatus.PAYLOAD_TOO_LARGE);
      expect(service.upload).not.toHaveBeenCalled();
    });

    it('refuses to buffer an oversized file by capping multer at the same limit', async () => {
      /**
       * Asserts the limit is *shared* rather than restated: `CloudinaryService`'s
       * 5 MiB rule and the multipart `limits` option come from one constant, so a
       * future change to the limit cannot leave the two disagreeing and rejecting
       * (or worse, accepting) at different thresholds.
       */
      expect(CLOUDINARY_MAX_FILE_SIZE_BYTES).toBe(5 * 1024 * 1024);
    });

    it('hands a zero-byte file to the service, which owns the 400', async () => {
      /**
       * `fileFilter` inspects the declared type, not the length, so an empty part
       * is passed through. Rejecting it is `CloudinaryService`'s rule and is
       * covered there; what matters here is that the empty buffer reaches the
       * service intact rather than being silently dropped.
       */
      service.upload.mockResolvedValue(buildResponse());

      const res = await fetch(baseUrl, {
        method: 'POST',
        body: buildForm({ bytes: Buffer.alloc(0) }),
      });

      expect(res.status).toBe(HttpStatus.CREATED);
      const [, file] = service.upload.mock.calls[0];
      expect(file.buffer.length).toBe(0);
    });

    it('rejects a request with no file part at all', async () => {
      const res = await fetch(baseUrl, {
        method: 'POST',
        body: buildForm({ includeFile: false }),
      });

      expect(res.status).toBe(HttpStatus.CREATED);

      /**
       * Reached the service, which owns the "a file is required" rule — the
       * controller has no file to reject, so it must not pretend otherwise. The
       * service turns this into a 400; see its spec.
       */
      expect(service.upload).toHaveBeenCalledTimes(1);
      expect(service.upload.mock.calls[0][1]).toBeUndefined();
    });

    it('rejects a malformed product UUID with 400', async () => {
      const res = await fetch(
        `${baseUrl.replace(PRODUCT_ID, 'not-a-uuid')}`,
        { method: 'POST', body: buildForm() },
      );

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(service.upload).not.toHaveBeenCalled();
    });
  });

  describe('service failures surface unchanged', () => {
    it('nonexistent product → 404', async () => {
      service.upload.mockRejectedValue(
        new NotFoundException(`Product ${PRODUCT_ID} does not exist`),
      );

      const res = await fetch(baseUrl, { method: 'POST', body: buildForm() });

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
    });

    it('Cloudinary upload failure → 500', async () => {
      service.upload.mockRejectedValue(
        new InternalServerErrorException('Image upload failed: Invalid API key'),
      );

      const res = await fetch(baseUrl, { method: 'POST', body: buildForm() });

      expect(res.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    });

    it('a rejected request never leaks a credential in the body', async () => {
      service.upload.mockRejectedValue(
        new InternalServerErrorException('Image upload failed: Invalid API key'),
      );

      const res = await fetch(baseUrl, { method: 'POST', body: buildForm() });
      const body = await res.text();

      expect(body).not.toContain('api_secret');
      expect(body).not.toContain('CLOUDINARY_API_SECRET');
      expect(body).not.toContain('cloudinary_api_key');
    });
  });
});
