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
import { CodAreasService } from '../../cod-areas/cod-areas.service.js';
import { CreateCodAreaDto } from '../../cod-areas/dto/create-cod-area.dto.js';
import { Role } from '../../generated/prisma/enums.js';
import { UsersRepository } from '../../users/repositories/users.repository.js';
import { AdminCodAreasController } from './admin-cod-areas.controller.js';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';
const AREA_ID = '33333333-3333-4333-8333-333333333333';

describe('AdminCodAreasController', () => {
  let controller: AdminCodAreasController;
  const service = {
    listForAdmin: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminCodAreasController],
      providers: [
        { provide: CodAreasService, useValue: service },
        JwtAuthGuard,
        RolesGuard,
        { provide: AccessTokenService, useValue: { verify: vi.fn() } },
        { provide: UsersRepository, useValue: { findById: vi.fn() } },
      ],
    }).compile();
    controller = module.get(AdminCodAreasController);
  });

  it('delegates list, create, and update requests to the COD-area service', () => {
    const dto = Object.assign(new CreateCodAreaDto(), {
      code: 'PHNOM-PENH',
      name: 'Phnom Penh',
    });
    service.listForAdmin.mockReturnValue([]);
    service.create.mockReturnValue({ id: AREA_ID });
    service.update.mockReturnValue({ id: AREA_ID });

    expect(controller.findAll()).toEqual([]);
    expect(controller.create(dto)).toEqual({ id: AREA_ID });
    expect(controller.update(AREA_ID, { codEnabled: true })).toEqual({ id: AREA_ID });
    expect(service.create).toHaveBeenCalledWith(dto);
    expect(service.update).toHaveBeenCalledWith(AREA_ID, { codEnabled: true });
  });

  it('requires JWT authentication followed by the ADMIN role guard', () => {
    expect(
      Reflect.getMetadata('__guards__', AdminCodAreasController),
    ).toEqual([JwtAuthGuard, RolesGuard]);
    expect(Reflect.getMetadata(ROLES_KEY, AdminCodAreasController)).toEqual([
      Role.ADMIN,
    ]);
  });
});

describe('AdminCodAreasController authorization and validation (HTTP)', () => {
  let app: INestApplication;
  let base: string;
  const service = {
    listForAdmin: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({ id: AREA_ID }),
    update: vi.fn(),
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
      controllers: [AdminCodAreasController],
      providers: [
        { provide: CodAreasService, useValue: service },
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

  it('rejects unauthenticated requests', async () => {
    const response = await fetch(`${base}/admin/cod-areas`);
    expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
  });

  it('rejects authenticated non-admin requests', async () => {
    const response = await fetch(`${base}/admin/cod-areas`, {
      headers: { Authorization: 'Bearer customer-token' },
    });
    expect(response.status).toBe(HttpStatus.FORBIDDEN);
  });

  it('allows admins to create an area and validates canonical identifiers', async () => {
    const response = await fetch(`${base}/admin/cod-areas`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ code: 'phnom-penh', name: 'Phnom Penh' }),
    });
    expect(response.status).toBe(HttpStatus.CREATED);
    expect(service.create).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'PHNOM-PENH', name: 'Phnom Penh' }),
    );

    const invalid = await fetch(`${base}/admin/cod-areas`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ code: 'bad_code', name: 'Bad code' }),
    });
    expect(invalid.status).toBe(HttpStatus.BAD_REQUEST);
  });
});
