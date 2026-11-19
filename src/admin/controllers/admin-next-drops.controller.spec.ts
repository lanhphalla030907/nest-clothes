import {
  BadRequestException,
  HttpStatus,
  NotFoundException,
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
import { CreateNextDropDto } from '../../next-drops/next-drops.dto.js';
import { UpdateNextDropDto } from '../../next-drops/next-drops.dto.js';
import { NextDropResponseDto } from '../../next-drops/next-drops.dto.js';
import { NextDropService } from '../../next-drops/next-drops.service.js';
import { NextDropAdminController } from './admin-next-drops.controller.js';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';
const NEXT_DROP_ID = '33333333-3333-4333-8333-333333333333';

const buildNextDrop = (
  overrides: Partial<NextDropResponseDto> = {},
): NextDropResponseDto =>
  Object.assign(
    {
      id: NEXT_DROP_ID,
      title: 'Winter Archive',
      launchAt: new Date('2026-12-01T10:00:00.000Z'),
      collectionId: null,
      promotionId: null,
      buttonText: 'Get Access',
      buttonUrl: 'https://shop.example.com/winter-archive',
      isPublished: false,
      createdAt: new Date('2026-11-01T00:00:00.000Z'),
      updatedAt: new Date('2026-11-01T00:00:00.000Z'),
    },
    overrides,
  );

type ServiceMock = {
  create: ReturnType<typeof vi.fn>;
  findPublished: ReturnType<typeof vi.fn>;
  findAll: ReturnType<typeof vi.fn>;
  findById: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
  unpublish: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
};

const createServiceMock = (): ServiceMock => ({
  create: vi.fn(),
  findPublished: vi.fn(),
  findAll: vi.fn(),
  findById: vi.fn(),
  update: vi.fn(),
  publish: vi.fn(),
  unpublish: vi.fn(),
  remove: vi.fn(),
});

describe('NextDropAdminController', () => {
  let controller: NextDropAdminController;
  let service: ServiceMock;

  beforeEach(async () => {
    service = createServiceMock();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [NextDropAdminController],
      providers: [
        { provide: NextDropService, useValue: service },
        JwtAuthGuard,
        RolesGuard,
        { provide: AccessTokenService, useValue: { verify: vi.fn() } },
        { provide: UsersRepository, useValue: { findById: vi.fn() } },
      ],
    }).compile();
    controller = module.get(NextDropAdminController);
  });

  it('requires JWT authentication followed by the ADMIN role guard', () => {
    expect(
      Reflect.getMetadata('__guards__', NextDropAdminController),
    ).toEqual([JwtAuthGuard, RolesGuard]);
    expect(Reflect.getMetadata(ROLES_KEY, NextDropAdminController)).toEqual([
      Role.ADMIN,
    ]);
  });

  it('delegates findAll to the next drop service', async () => {
    const expected = [buildNextDrop()];
    service.findAll.mockResolvedValue(expected);
    const result = await controller.findAll();
    expect(result).toBe(expected);
    expect(service.findAll).toHaveBeenCalledTimes(1);
  });

  it('delegates findById to the next drop service', async () => {
    const expected = buildNextDrop();
    service.findById.mockResolvedValue(expected);
    const result = await controller.findOne(NEXT_DROP_ID);
    expect(result).toBe(expected);
    expect(service.findById).toHaveBeenCalledWith(NEXT_DROP_ID);
  });

  it('delegates create to the next drop service', async () => {
    const dto = Object.assign(new CreateNextDropDto(), {
      title: 'Winter Archive',
      launchAt: '2026-12-01T10:00:00.000Z',
      buttonUrl: 'https://shop.example.com/winter-archive',
    });
    const expected = buildNextDrop({ isPublished: false });
    service.create.mockResolvedValue(expected);
    const result = await controller.create(dto);
    expect(result).toBe(expected);
    expect(service.create).toHaveBeenCalledTimes(1);
    expect(service.create).toHaveBeenCalledWith(dto);
  });

  it('delegates update to the next drop service', async () => {
    const dto = Object.assign(new UpdateNextDropDto(), { title: 'Renamed' });
    const expected = buildNextDrop({ title: 'Renamed' });
    service.update.mockResolvedValue(expected);
    const result = await controller.update(NEXT_DROP_ID, dto);
    expect(result).toBe(expected);
    expect(service.update).toHaveBeenCalledTimes(1);
    expect(service.update).toHaveBeenCalledWith(NEXT_DROP_ID, dto);
  });

  it('delegates publish and unpublish to the next drop service', async () => {
    const published = buildNextDrop({ isPublished: true });
    const unpublished = buildNextDrop({ isPublished: false });
    service.publish.mockResolvedValue(published);
    service.unpublish.mockResolvedValue(unpublished);

    await expect(controller.publish(NEXT_DROP_ID)).resolves.toBe(published);
    await expect(controller.unpublish(NEXT_DROP_ID)).resolves.toBe(unpublished);
    expect(service.publish).toHaveBeenCalledWith(NEXT_DROP_ID);
    expect(service.unpublish).toHaveBeenCalledWith(NEXT_DROP_ID);
  });

  it('delegates remove to the next drop service', async () => {
    service.remove.mockResolvedValue(undefined);
    await expect(controller.remove(NEXT_DROP_ID)).resolves.toBeUndefined();
    expect(service.remove).toHaveBeenCalledWith(NEXT_DROP_ID);
  });

  it('propagates service errors unchanged', async () => {
    const notFound = new NotFoundException('Next drop does not exist');
    service.findById.mockRejectedValue(notFound);
    await expect(controller.findOne(NEXT_DROP_ID)).rejects.toBe(notFound);
  });
});

describe('NextDropAdminController authorization (HTTP)', () => {
  let app: INestApplication;
  let base: string;
  let service: ServiceMock;
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
    service = createServiceMock();
    service.findAll.mockResolvedValue([]);
    service.findById.mockResolvedValue(buildNextDrop());
    service.create.mockResolvedValue(buildNextDrop());
    service.update.mockResolvedValue(buildNextDrop());
    service.publish.mockResolvedValue(buildNextDrop({ isPublished: true }));
    service.unpublish.mockResolvedValue(buildNextDrop({ isPublished: false }));
    service.remove.mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [NextDropAdminController],
      providers: [
        { provide: NextDropService, useValue: service },
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

  beforeEach(() => {
    vi.clearAllMocks();
    service.findAll.mockResolvedValue([]);
  });

  it('rejects unauthenticated requests', async () => {
    const response = await fetch(`${base}/admin/next-drops`);
    expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
  });

  it('rejects authenticated non-admin requests', async () => {
    const response = await fetch(`${base}/admin/next-drops`, {
      headers: { Authorization: 'Bearer customer-token' },
    });
    expect(response.status).toBe(HttpStatus.FORBIDDEN);
    expect(service.findAll).not.toHaveBeenCalled();
  });

  it('allows admins to list and read next drops', async () => {
    const headers = { Authorization: 'Bearer admin-token' };
    const list = await fetch(`${base}/admin/next-drops`, { headers });
    expect(list.status).toBe(HttpStatus.OK);

    const read = await fetch(`${base}/admin/next-drops/${NEXT_DROP_ID}`, {
      headers,
    });
    expect(read.status).toBe(HttpStatus.OK);
  });

  it('allows admins to create, update, publish, unpublish, and remove', async () => {
    const headers = {
      Authorization: 'Bearer admin-token',
      'Content-Type': 'application/json',
    };

    const create = await fetch(`${base}/admin/next-drops`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title: 'Winter Archive',
        launchAt: '2026-12-01T10:00:00.000Z',
        buttonUrl: 'https://shop.example.com/winter-archive',
      }),
    });
    expect(create.status).toBe(HttpStatus.CREATED);

    const update = await fetch(`${base}/admin/next-drops/${NEXT_DROP_ID}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ title: 'Renamed' }),
    });
    expect(update.status).toBe(HttpStatus.OK);

    const publish = await fetch(
      `${base}/admin/next-drops/${NEXT_DROP_ID}/publish`,
      { method: 'POST', headers },
    );
    expect(publish.status).toBe(HttpStatus.OK);

    const unpublish = await fetch(
      `${base}/admin/next-drops/${NEXT_DROP_ID}/unpublish`,
      { method: 'POST', headers },
    );
    expect(unpublish.status).toBe(HttpStatus.OK);

    const remove = await fetch(`${base}/admin/next-drops/${NEXT_DROP_ID}`, {
      method: 'DELETE',
      headers,
    });
    expect(remove.status).toBe(HttpStatus.NO_CONTENT);
  });

  it('propagates service failures as HTTP errors', async () => {
    service.findById.mockRejectedValue(
      new BadRequestException('Invalid next drop'),
    );
    const response = await fetch(`${base}/admin/next-drops/${NEXT_DROP_ID}`, {
      headers: { Authorization: 'Bearer admin-token' },
    });
    expect(response.status).toBe(HttpStatus.BAD_REQUEST);
  });
});
