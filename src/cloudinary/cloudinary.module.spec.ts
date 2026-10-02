import { Test, TestingModule } from '@nestjs/testing';
import { CloudinaryModule } from './cloudinary.module.js';
import { CloudinaryService } from './cloudinary.service.js';
import {
  CLOUDINARY_CLIENT,
  CLOUDINARY_CREDENTIALS,
  type CloudinaryClient,
  type CloudinaryCredentials,
} from './cloudinary.types.js';

const CREDENTIALS: CloudinaryCredentials = Object.freeze({
  cloudName: 'demo-cloud',
  apiKey: '123456789012345',
  apiSecret: 'super-secret',
});

/** Injection token owned by the test's own consumer module. */
const CONSUMER_TOKEN = Symbol('CONSUMER_TOKEN');

const buildClient = (): CloudinaryClient => ({
  uploader: {
    upload_stream: vi.fn() as unknown as CloudinaryClient['uploader']['upload_stream'],
    destroy: vi.fn(),
  },
});

/**
 * Compiles the real `CloudinaryModule` but swaps the two environment-derived
 * providers for stubs, so these tests exercise the module's *wiring* — which token
 * resolves to what, and what the module exports — without configuring the real
 * Cloudinary SDK or needing credentials in the environment.
 */
const buildModuleWithStubbedProviders = async () => {
  const module: TestingModule = await Test.createTestingModule({
    imports: [CloudinaryModule],
  })
    .overrideProvider(CLOUDINARY_CREDENTIALS)
    .useValue(CREDENTIALS)
    .overrideProvider(CLOUDINARY_CLIENT)
    .useValue(buildClient())
    .compile();

  return module;
};

describe('CloudinaryModule', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves CloudinaryService', async () => {
    const module = await buildModuleWithStubbedProviders();

    expect(module.get(CloudinaryService)).toBeInstanceOf(CloudinaryService);
  });

  it('exports CloudinaryService so other modules can inject it', async () => {
    const module = await buildModuleWithStubbedProviders();

    expect(module.get(CloudinaryService)).toBeDefined();
  });

  it('injects the configured client into the service', async () => {
    const client = buildClient();
    const module = await Test.createTestingModule({
      imports: [CloudinaryModule],
    })
      .overrideProvider(CLOUDINARY_CREDENTIALS)
      .useValue(CREDENTIALS)
      .overrideProvider(CLOUDINARY_CLIENT)
      .useValue(client)
      .compile();

    const service = module.get(CloudinaryService);

    await service
      .upload({ buffer: Buffer.from('x'), mimeType: 'image/jpeg' })
      .catch(() => undefined);

    expect(client.uploader.upload_stream).toHaveBeenCalledTimes(1);
  });

  it('exports CloudinaryService to a consuming module', async () => {
    const consumer = await Test.createTestingModule({
      imports: [CloudinaryModule],
      providers: [{ provide: CONSUMER_TOKEN, inject: [CloudinaryService], useFactory: (svc: CloudinaryService) => svc }],
    })
      .overrideProvider(CLOUDINARY_CREDENTIALS)
      .useValue(CREDENTIALS)
      .overrideProvider(CLOUDINARY_CLIENT)
      .useValue(buildClient())
      .compile();

    expect(consumer.get(CONSUMER_TOKEN)).toBeInstanceOf(CloudinaryService);
  });

  it.each([
    ['the raw client', CLOUDINARY_CLIENT],
    ['the credentials', CLOUDINARY_CREDENTIALS],
  ])('does not export %s, so no caller can bypass the service', async (_label, token) => {
    /**
     * Nest's container `get(..., { strict: false })` searches every module in the
     * process, so it can reach a provider a module never exported — that is not a
     * measure of the module's public surface. The real guarantee is whether another
     * module can *inject* the token, so this asks exactly that: a consumer module
     * declaring a dependency on the token must fail to resolve it.
     *
     * Keeping the client and the credentials internal is what guarantees the only
     * path to Cloudinary runs through the validated service.
     */
    await expect(
      Test.createTestingModule({
        imports: [CloudinaryModule],
        providers: [
          { provide: CONSUMER_TOKEN, inject: [token], useFactory: (value: unknown) => value },
        ],
      })
        .overrideProvider(CLOUDINARY_CREDENTIALS)
        .useValue(CREDENTIALS)
        .overrideProvider(CLOUDINARY_CLIENT)
        .useValue(buildClient())
        .compile(),
    ).rejects.toThrow();
  });

  it('is registered in AppModule', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../app.module.ts', import.meta.url), 'utf8'),
    );

    expect(source).toContain('CloudinaryModule');
  });
});

describe('CloudinaryModule (real providers)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('fails to construct when the Cloudinary variables are absent', async () => {
    delete process.env.CLOUDINARY_CLOUD_NAME;
    delete process.env.CLOUDINARY_API_KEY;
    delete process.env.CLOUDINARY_API_SECRET;

    /**
     * Asserted against a module that omits the overrides, so the real credentials
     * provider runs. This is the behaviour that turns a misconfigured deployment
     * into a startup failure rather than a confusing 500 on the first upload.
     */
    await expect(
      Test.createTestingModule({ imports: [CloudinaryModule] }).compile(),
    ).rejects.toThrow(/Cloudinary is not configured/);
  });

  it('constructs when all three variables are present', async () => {
    process.env.CLOUDINARY_CLOUD_NAME = 'demo-cloud';
    process.env.CLOUDINARY_API_KEY = '123456789012345';
    process.env.CLOUDINARY_API_SECRET = 'super-secret';

    const module = await Test.createTestingModule({ imports: [CloudinaryModule] })
      .overrideProvider(CLOUDINARY_CLIENT)
      .useValue(buildClient())
      .compile();

    expect(module.get(CloudinaryService)).toBeInstanceOf(CloudinaryService);
  });
});
