import {
  HttpStatus,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ROLES_KEY } from '../../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../auth/guards/roles.guard.js';
import { AccessTokenService } from '../../auth/jwt/access-token.service.js';
import { ACTIVE_USER_STATUS } from '../../common/constants/user-status.constants.js';
import { Role } from '../../generated/prisma/enums.js';
import { UsersRepository } from '../../users/repositories/users.repository.js';
import { CategoriesService } from '../../categories/categories.service.js';
import { CategoryResponseDto } from '../../categories/dto/category-response.dto.js';
import { AdminCategoriesController } from './admin-categories.controller.js';
import type { UploadedCategoryImageFile } from '../../categories/interfaces/uploaded-category-image-file.js';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';
const CATEGORY_ID = '33333333-3333-4333-8333-333333333333';

const buildResponse = (
  overrides: Partial<CategoryResponseDto> = {},
): CategoryResponseDto =>
  Object.assign(new CategoryResponseDto(), {
    id: CATEGORY_ID,
    name: 'Clothing',
    slug: 'clothing',
    description: null,
    parentId: null,
    isActive: true,
    imageUrl: null,
    publicId: null,
    altText: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

describe('AdminCategoriesController', () => {
  let controller: AdminCategoriesController;
  const service = {
    findAll: vi.fn(),
    findOne: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    uploadImage: vi.fn(),
    removeImage: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminCategoriesController],
      providers: [
        { provide: CategoriesService, useValue: service },
        JwtAuthGuard,
        RolesGuard,
        { provide: AccessTokenService, useValue: { verify: vi.fn() } },
        { provide: UsersRepository, useValue: { findById: vi.fn() } },
      ],
    }).compile();
    controller = module.get(AdminCategoriesController);
  });

  it('delegates image upload to the categories service', async () => {
    const expected = buildResponse({
      imageUrl: 'https://res.cloudinary.com/demo/image/upload/products/abc.jpg',
      publicId: 'products/abc',
    });
    service.uploadImage.mockResolvedValue(expected);

    const file = {
      originalname: 'photo.jpg',
      size: 1234,
      mimetype: 'image/jpeg',
      buffer: Buffer.from('fake-bytes'),
    } as UploadedCategoryImageFile;

    const result = await controller.uploadImage(CATEGORY_ID, file, {
      altText: 'A category image',
    });

    expect(result).toBe(expected);
    expect(service.uploadImage).toHaveBeenCalledTimes(1);
    expect(service.uploadImage).toHaveBeenCalledWith(CATEGORY_ID, file, {
      altText: 'A category image',
    });
  });

  it('delegates image removal to the categories service', async () => {
    service.removeImage.mockResolvedValue(undefined);

    await expect(controller.removeImage(CATEGORY_ID)).resolves.toBeUndefined();
    expect(service.removeImage).toHaveBeenCalledTimes(1);
    expect(service.removeImage).toHaveBeenCalledWith(CATEGORY_ID);
  });

  it('requires JWT authentication followed by the ADMIN role guard', () => {
    expect(
      Reflect.getMetadata('__guards__', AdminCategoriesController),
    ).toEqual([JwtAuthGuard, RolesGuard]);
    expect(Reflect.getMetadata(ROLES_KEY, AdminCategoriesController)).toEqual([
      Role.ADMIN,
    ]);
  });
});

describe('AdminCategoriesController authorization (HTTP)', () => {
  let app: INestApplication;
  let base: string;
  const service = {
    findAll: vi.fn().mockResolvedValue([]),
    findOne: vi.fn().mockResolvedValue(buildResponse()),
    create: vi.fn().mockResolvedValue(buildResponse()),
    update: vi.fn().mockResolvedValue(buildResponse()),
    remove: vi.fn().mockResolvedValue(undefined),
    uploadImage: vi.fn().mockResolvedValue(buildResponse()),
    removeImage: vi.fn().mockResolvedValue(undefined),
  };
  const accessTokenService = {
    verify: vi.fn(async (token: string) => ({
      sub: token === 'admin-token' ? ADMIN_ID : CUSTOMER_ID,
    })),
  };
  const usersRepository = {
    findById: vi.fn(async (id: string) => ({
      id,
      email: id === ADMIN_ID ? 'admin@example.test' : 'customer@example.test',
      role: id === ADMIN_ID ? Role.ADMIN : Role.CUSTOMER,
      status: ACTIVE_USER_STATUS,
    })),
  };

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminCategoriesController],
      providers: [
        { provide: CategoriesService, useValue: service },
        JwtAuthGuard,
        RolesGuard,
        { provide: AccessTokenService, useValue: accessTokenService },
        { provide: UsersRepository, useValue: usersRepository },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.listen(0);
    base = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects unauthenticated image upload', async () => {
    const response = await fetch(
      `${base}/admin/categories/${CATEGORY_ID}/images/upload`,
      { method: 'POST' },
    );
    expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
  });

  it('rejects authenticated non-admin image upload', async () => {
    const response = await fetch(
      `${base}/admin/categories/${CATEGORY_ID}/images/upload`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer customer-token' },
      },
    );
    expect(response.status).toBe(HttpStatus.FORBIDDEN);
  });

  it('allows ADMIN image upload', async () => {
    service.uploadImage.mockResolvedValue(buildResponse());

    const response = await fetch(
      `${base}/admin/categories/${CATEGORY_ID}/images/upload`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-token' },
      },
    );
    expect(response.status).toBe(HttpStatus.CREATED);
    expect(service.uploadImage).toHaveBeenCalledTimes(1);
  });

  it('rejects unauthenticated image removal', async () => {
    const response = await fetch(
      `${base}/admin/categories/${CATEGORY_ID}/images`,
      { method: 'DELETE' },
    );
    expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
  });

  it('rejects authenticated non-admin image removal', async () => {
    const response = await fetch(
      `${base}/admin/categories/${CATEGORY_ID}/images`,
      {
        method: 'DELETE',
        headers: { Authorization: 'Bearer customer-token' },
      },
    );
    expect(response.status).toBe(HttpStatus.FORBIDDEN);
  });

  it('allows ADMIN image removal', async () => {
    const response = await fetch(
      `${base}/admin/categories/${CATEGORY_ID}/images`,
      {
        method: 'DELETE',
        headers: { Authorization: 'Bearer admin-token' },
      },
    );
    expect(response.status).toBe(HttpStatus.NO_CONTENT);
    expect(service.removeImage).toHaveBeenCalledWith(CATEGORY_ID);
  });
});
