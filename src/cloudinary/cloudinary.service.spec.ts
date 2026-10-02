import { EventEmitter } from 'node:events';
import {
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  CLOUDINARY_ALLOWED_FORMATS,
  CLOUDINARY_MAX_FILE_SIZE_BYTES,
  CLOUDINARY_RESOURCE_TYPE,
  CLOUDINARY_UPLOAD_FOLDER,
} from './cloudinary.constants.js';
import { CloudinaryService } from './cloudinary.service.js';
import {
  CLOUDINARY_CLIENT,
  CLOUDINARY_CREDENTIALS,
  type CloudinaryClient,
  type CloudinaryCredentials,
} from './cloudinary.types.js';

const API_SECRET = 'shhh-super-secret';
const API_KEY = '123456789012345';
const CLOUD_NAME = 'demo-cloud';

const CREDENTIALS: CloudinaryCredentials = Object.freeze({
  cloudName: CLOUD_NAME,
  apiKey: API_KEY,
  apiSecret: API_SECRET,
});

const JPEG_BYTES = Buffer.from('ffd8ffe000104a464946', 'hex');

/**
 * A minimal stand-in for the SDK's writable upload stream.
 *
 * `EventEmitter` is mixed in so the stub behaves like the real writable with
 * respect to `error` events, which is the failure path where Cloudinary's
 * callback is never invoked at all.
 */
const buildWritable = () => {
  const chunks: Buffer[] = [];
  const stream = Object.assign(new EventEmitter(), {
    end: (chunk: Buffer) => {
      chunks.push(chunk);

      return stream;
    },
    chunks,
  });

  return stream;
};

const sdkResponse = (overrides: Record<string, unknown> = {}) => ({
  public_id: 'products/abc123',
  version: 1_700_000_000,
  signature: 'a-signature-value',
  width: 1200,
  height: 1600,
  format: 'jpg',
  resource_type: 'image',
  created_at: '2026-01-01T00:00:00Z',
  tags: [],
  bytes: 123_456,
  type: 'upload',
  etag: 'an-etag',
  url: 'http://res.cloudinary.com/demo-cloud/image/upload/products/abc123.jpg',
  secure_url:
    'https://res.cloudinary.com/demo-cloud/image/upload/products/abc123.jpg',
  original_filename: 'front.jpg',
  api_key: API_KEY,
  context: {},
  metadata: {},
  moderation: [],
  ...overrides,
});

describe('CloudinaryService', () => {
  let service: CloudinaryService;
  let uploadStream: ReturnType<typeof vi.fn>;
  let destroy: ReturnType<typeof vi.fn>;
  let writable: ReturnType<typeof buildWritable>;

  /** Builds the service with a stub client whose calls are captured. */
  const buildService = async (
    overrides: {
      credentials?: CloudinaryCredentials;
      client?: Partial<CloudinaryClient>;
    } = {},
  ): Promise<CloudinaryService> => {
    uploadStream = vi.fn();
    destroy = vi.fn();
    writable = buildWritable();

    const client: CloudinaryClient = {
      uploader: {
        upload_stream: uploadStream,
        destroy,
        ...overrides.client?.uploader,
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CloudinaryService,
        { provide: CLOUDINARY_CLIENT, useValue: client },
        {
          provide: CLOUDINARY_CREDENTIALS,
          useValue: overrides.credentials ?? CREDENTIALS,
        },
      ],
    }).compile();

    return module.get<CloudinaryService>(CloudinaryService);
  };

  beforeEach(async () => {
    service = await buildService();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('upload', () => {
    /** Makes the stub answer the next upload with `response`. */
    const respondWith = (response: Record<string, unknown>) => {
      uploadStream.mockImplementation(
        (
          _options: unknown,
          callback: (error: unknown, result: unknown) => void,
        ) => {
          callback(null, response);

          return writable;
        },
      );
    };

    /** Makes the stub fail the next upload with `error`. */
    const failWith = (error: unknown) => {
      uploadStream.mockImplementation(
        (
          _options: unknown,
          callback: (error: unknown, result: unknown) => void,
        ) => {
          callback(error, undefined);

          return writable;
        },
      );
    };

    it('uploads an in-memory buffer and resolves with safe metadata', async () => {
      respondWith(sdkResponse());

      const result = await service.upload({
        buffer: JPEG_BYTES,
        mimeType: 'image/jpeg',
      });

      expect(result).toEqual({
        secureUrl:
          'https://res.cloudinary.com/demo-cloud/image/upload/products/abc123.jpg',
        publicId: 'products/abc123',
        width: 1200,
        height: 1600,
        format: 'jpg',
        bytes: 123_456,
      });
    });

    it('sends the exact buffer bytes through the stream', async () => {
      respondWith(sdkResponse());

      await service.upload({ buffer: JPEG_BYTES, mimeType: 'image/jpeg' });

      expect(uploadStream).toHaveBeenCalledTimes(1);
      expect(writable.chunks).toHaveLength(1);
      expect(writable.chunks[0]).toEqual(JPEG_BYTES);
    });

    it('pins folder, resource_type and allowed_formats on the upload', async () => {
      respondWith(sdkResponse());

      await service.upload({ buffer: JPEG_BYTES, mimeType: 'image/jpeg' });

      const options = uploadStream.mock.calls[0][0];

      expect(options).toMatchObject({
        folder: CLOUDINARY_UPLOAD_FOLDER,
        resource_type: CLOUDINARY_RESOURCE_TYPE,
        allowed_formats: [...CLOUDINARY_ALLOWED_FORMATS],
      });
      expect(options.overwrite).toBe(false);
    });

    it('never forwards a caller-supplied filename or publicId', async () => {
      respondWith(sdkResponse());

      await service.upload({
        buffer: JPEG_BYTES,
        mimeType: 'image/jpeg',
      });

      const options = uploadStream.mock.calls[0][0];

      expect(options).not.toHaveProperty('public_id');
      expect(options).not.toHaveProperty('filename_override');
      expect(options).not.toHaveProperty('use_filename');
    });

    it('returns exactly the six documented fields and nothing else', async () => {
      respondWith(sdkResponse());

      const result = await service.upload({
        buffer: JPEG_BYTES,
        mimeType: 'image/jpeg',
      });

      expect(Object.keys(result).sort()).toEqual([
        'bytes',
        'format',
        'height',
        'publicId',
        'secureUrl',
        'width',
      ]);
    });

    it('drops the SDK signature and api_key rather than forwarding them', async () => {
      respondWith(sdkResponse());

      const result = await service.upload({
        buffer: JPEG_BYTES,
        mimeType: 'image/jpeg',
      });

      const serialised = JSON.stringify(result);

      expect(serialised).not.toContain('a-signature-value');
      expect(serialised).not.toContain(API_KEY);
      expect(result).not.toHaveProperty('signature');
      expect(result).not.toHaveProperty('api_key');
    });

    it.each([
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/avif',
      'image/gif',
    ])('accepts %s', async (mimeType) => {
      respondWith(sdkResponse());

      await expect(
        service.upload({ buffer: JPEG_BYTES, mimeType }),
      ).resolves.toBeDefined();
    });

    it('accepts a mixed-case MIME type with a charset parameter', async () => {
      respondWith(sdkResponse());

      await expect(
        service.upload({
          buffer: JPEG_BYTES,
          mimeType: 'IMAGE/JPEG; charset=binary',
        }),
      ).resolves.toBeDefined();
    });

    it('coerces a partial SDK response instead of returning undefined', async () => {
      respondWith({ public_id: 'products/partial' });

      const result = await service.upload({
        buffer: JPEG_BYTES,
        mimeType: 'image/jpeg',
      });

      expect(result).toEqual({
        secureUrl: '',
        publicId: 'products/partial',
        width: 0,
        height: 0,
        format: '',
        bytes: 0,
      });
    });

    describe('validation', () => {
      it('rejects an empty buffer with 400 and never calls the SDK', async () => {
        await expect(
          service.upload({ buffer: Buffer.alloc(0), mimeType: 'image/jpeg' }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(uploadStream).not.toHaveBeenCalled();
      });

      it('rejects a buffer larger than the limit with 400 and never calls the SDK', async () => {
        const oversized = Buffer.alloc(CLOUDINARY_MAX_FILE_SIZE_BYTES + 1, 0x41);

        await expect(
          service.upload({ buffer: oversized, mimeType: 'image/jpeg' }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(uploadStream).not.toHaveBeenCalled();
      });

      it('accepts a buffer exactly at the limit', async () => {
        respondWith(sdkResponse());

        const atLimit = Buffer.alloc(CLOUDINARY_MAX_FILE_SIZE_BYTES, 0x41);

        await expect(
          service.upload({ buffer: atLimit, mimeType: 'image/jpeg' }),
        ).resolves.toBeDefined();
      });

      it.each([
        'application/pdf',
        'video/mp4',
        'text/plain',
        'image/svg+xml',
        'application/octet-stream',
      ])('rejects %s with 400', async (mimeType) => {
        await expect(
          service.upload({ buffer: JPEG_BYTES, mimeType }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(uploadStream).not.toHaveBeenCalled();
      });

      it('rejects an empty MIME type with 400', async () => {
        await expect(
          service.upload({ buffer: JPEG_BYTES, mimeType: '' }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(uploadStream).not.toHaveBeenCalled();
      });

      it('names the allowed types in the rejection message', async () => {
        await expect(
          service.upload({ buffer: JPEG_BYTES, mimeType: 'application/pdf' }),
        ).rejects.toThrow(/image\/jpeg/);
      });

      it('checks size before MIME type so an oversized file leaks nothing about types', async () => {
        const oversized = Buffer.alloc(CLOUDINARY_MAX_FILE_SIZE_BYTES + 1, 0x41);

        await expect(
          service.upload({ buffer: oversized, mimeType: 'application/pdf' }),
        ).rejects.toThrow(/maximum size/);
      });
    });

    describe('failures', () => {
      it('maps an SDK upload error to 500', async () => {
        failWith({ message: 'File size too large', http_code: 413 });

        await expect(
          service.upload({ buffer: JPEG_BYTES, mimeType: 'image/jpeg' }),
        ).rejects.toBeInstanceOf(InternalServerErrorException);
      });

      it('includes the upstream message so the failure is actionable', async () => {
        failWith({ message: 'Invalid API key', http_code: 401 });

        await expect(
          service.upload({ buffer: JPEG_BYTES, mimeType: 'image/jpeg' }),
        ).rejects.toThrow(/Invalid API key/);
      });

      it('survives a non-Error rejection value', async () => {
        failWith('something went wrong');

        await expect(
          service.upload({ buffer: JPEG_BYTES, mimeType: 'image/jpeg' }),
        ).rejects.toBeInstanceOf(InternalServerErrorException);
      });

      it('handles an error carrying no message', async () => {
        failWith({ http_code: 500 });

        await expect(
          service.upload({ buffer: JPEG_BYTES, mimeType: 'image/jpeg' }),
        ).rejects.toBeInstanceOf(InternalServerErrorException);
      });

      it('maps a stream error event to 500 even though no callback arrives', async () => {
        /**
         * The case a callback-only implementation silently drops: the transport
         * fails while the buffer is being written, so the promise would never
         * settle and the request would hang until the client gave up.
         */
        uploadStream.mockImplementation(
          () => {
            queueMicrotask(() => {
              writable.emit('error', new Error('socket hang up'));
            });

            return writable;
          },
        );

        await expect(
          service.upload({ buffer: JPEG_BYTES, mimeType: 'image/jpeg' }),
        ).rejects.toBeInstanceOf(InternalServerErrorException);
      });

      it('reports the stream error detail without leaking credentials', async () => {
        uploadStream.mockImplementation(
          () => {
            queueMicrotask(() => {
              writable.emit('error', new Error(`socket failed for ${API_SECRET}`));
            });

            return writable;
          },
        );

        await expect(
          service.upload({ buffer: JPEG_BYTES, mimeType: 'image/jpeg' }),
        ).rejects.toThrow(/socket failed for \[redacted\]/);
      });

      it('maps a synchronous SDK throw to 500', async () => {
        uploadStream.mockImplementation(() => {
          throw new Error('upload_stream exploded');
        });

        await expect(
          service.upload({ buffer: JPEG_BYTES, mimeType: 'image/jpeg' }),
        ).rejects.toBeInstanceOf(InternalServerErrorException);
      });

      it('maps a synchronous stream write failure to 500', async () => {
        uploadStream.mockImplementation(() => {
          writable.end = () => {
            throw new Error('stream already destroyed');
          };

          return writable;
        });

        await expect(
          service.upload({ buffer: JPEG_BYTES, mimeType: 'image/jpeg' }),
        ).rejects.toBeInstanceOf(InternalServerErrorException);
      });
    });

    describe('secret safety', () => {
      it('redacts the API secret from an upstream error message', async () => {
        failWith({ message: `Auth failed for secret ${API_SECRET}` });

        let message = '';

        try {
          await service.upload({ buffer: JPEG_BYTES, mimeType: 'image/jpeg' });
        } catch (error) {
          message = (error as Error).message;
        }

        expect(message).not.toContain(API_SECRET);
        expect(message).toContain('[redacted]');
      });

      it('redacts the API key and cloud name too', async () => {
        failWith({ message: `Bad ${API_KEY} in ${CLOUD_NAME}` });

        let message = '';

        try {
          await service.upload({ buffer: JPEG_BYTES, mimeType: 'image/jpeg' });
        } catch (error) {
          message = (error as Error).message;
        }

        expect(message).not.toContain(API_KEY);
        expect(message).not.toContain(CLOUD_NAME);
      });

      it('redacts every occurrence, not just the first', async () => {
        failWith({ message: `${API_SECRET} and again ${API_SECRET}` });

        let message = '';

        try {
          await service.upload({ buffer: JPEG_BYTES, mimeType: 'image/jpeg' });
        } catch (error) {
          message = (error as Error).message;
        }

        expect(message).not.toContain(API_SECRET);
        expect(message.match(/\[redacted\]/g)).toHaveLength(2);
      });

      it('leaves a legitimate upload result free of credentials', async () => {
        respondWith(sdkResponse());

        const result = await service.upload({
          buffer: JPEG_BYTES,
          mimeType: 'image/jpeg',
        });

        expect(JSON.stringify(result)).not.toContain(API_SECRET);
        expect(JSON.stringify(result)).not.toContain(API_KEY);
      });
    });
  });

  describe('deleteAsset', () => {
    it('deletes by public_id and resolves true', async () => {
      destroy.mockImplementation(
        (
          _publicId: string,
          _options: unknown,
          callback: (error: unknown, result: unknown) => void,
        ) => {
          callback(null, { result: 'ok' });
        },
      );

      await expect(
        service.deleteAsset('products/abc123'),
      ).resolves.toBe(true);

      expect(destroy).toHaveBeenCalledTimes(1);
      expect(destroy.mock.calls[0][0]).toBe('products/abc123');
    });

    it('pins resource_type so a delete cannot target another asset type', async () => {
      destroy.mockImplementation(
        (
          _publicId: string,
          _options: unknown,
          callback: (error: unknown, result: unknown) => void,
        ) => {
          callback(null, {});
        },
      );

      await service.deleteAsset('products/abc123');

      expect(destroy.mock.calls[0][1]).toMatchObject({
        resource_type: CLOUDINARY_RESOURCE_TYPE,
      });
    });

    it('treats an already-absent asset as success', async () => {
      destroy.mockImplementation(
        (
          _publicId: string,
          _options: unknown,
          callback: (error: unknown, result: unknown) => void,
        ) => {
          callback({ message: 'Resource not found', http_code: 404 }, undefined);
        },
      );

      await expect(service.deleteAsset('products/gone')).resolves.toBe(true);
    });

    it('maps a real SDK delete failure to 500', async () => {
      destroy.mockImplementation(
        (
          _publicId: string,
          _options: unknown,
          callback: (error: unknown, result: unknown) => void,
        ) => {
          callback({ message: 'Invalid API key', http_code: 401 }, undefined);
        },
      );

      await expect(service.deleteAsset('products/abc123')).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });

    it('redacts credentials from a delete failure message', async () => {
      destroy.mockImplementation(
        (
          _publicId: string,
          _options: unknown,
          callback: (error: unknown, result: unknown) => void,
        ) => {
          callback({ message: `Rejected secret ${API_SECRET}` }, undefined);
        },
      );

      let message = '';

      try {
        await service.deleteAsset('products/abc123');
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).not.toContain(API_SECRET);
    });

    it('rejects an empty publicId with 400 and never calls the SDK', async () => {
      await expect(service.deleteAsset('')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(service.deleteAsset('   ')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(destroy).not.toHaveBeenCalled();
    });
  });
});
