import {
  HttpStatus,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Role } from '../../generated/prisma/enums.js';
import { ROLES_KEY } from '../../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../auth/guards/roles.guard.js';
import { AccessTokenService } from '../../auth/jwt/access-token.service.js';
import { ACTIVE_USER_STATUS } from '../../common/constants/user-status.constants.js';
import { CreateShippingProviderDto } from '../../shipping-providers/dto/create-shipping-provider.dto.js';
import { ShippingProvidersService } from '../../shipping-providers/shipping-providers.service.js';
import { UsersRepository } from '../../users/repositories/users.repository.js';
import { AdminShippingProvidersController } from './admin-shipping-providers.controller.js';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';

describe('AdminShippingProvidersController', () => {
  let controller: AdminShippingProvidersController;
  const service = {
    listForAdmin: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminShippingProvidersController],
      providers: [
        { provide: ShippingProvidersService, useValue: service },
        { provide: AccessTokenService, useValue: { verify: vi.fn() } },
        { provide: UsersRepository, useValue: { findById: vi.fn() } },
        JwtAuthGuard,
        RolesGuard,
      ],
    }).compile();
    controller = module.get(AdminShippingProvidersController);
  });

  it('delegates list, create, and update requests to the shipping service', () => {
    const dto = Object.assign(new CreateShippingProviderDto(), {
      code: 'COURIER',
      name: 'Courier',
      baseFee: '2.00',
    });
    const expected = { id: 'provider-1' };
    service.listForAdmin.mockReturnValue([expected]);
    service.create.mockReturnValue(expected);
    service.update.mockReturnValue(expected);

    expect(controller.findAll()).toEqual([expected]);
    expect(controller.create(dto)).toBe(expected);
    expect(controller.update('provider-1', dto)).toBe(expected);
    expect(service.listForAdmin).toHaveBeenCalledOnce();
    expect(service.create).toHaveBeenCalledWith(dto);
    expect(service.update).toHaveBeenCalledWith('provider-1', dto);
  });

  it('requires JWT authentication followed by the ADMIN role guard', () => {
    const guards = Reflect.getMetadata('__guards__', AdminShippingProvidersController);
    expect(guards).toEqual([JwtAuthGuard, RolesGuard]);
    expect(Reflect.getMetadata(ROLES_KEY, AdminShippingProvidersController)).toEqual([
      Role.ADMIN,
    ]);
  });
});

describe('AdminShippingProvidersController authorization (HTTP)', () => {
  let app: INestApplication;
  let base: string;
  const service = {
    listForAdmin: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
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
      controllers: [AdminShippingProvidersController],
      providers: [
        { provide: ShippingProvidersService, useValue: service },
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
    const response = await fetch(`${base}/admin/shipping-providers`);
    expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
  });

  it('rejects authenticated non-admin requests', async () => {
    const response = await fetch(`${base}/admin/shipping-providers`, {
      headers: { Authorization: 'Bearer customer-token' },
    });
    expect(response.status).toBe(HttpStatus.FORBIDDEN);
  });

  it('allows admins to list providers', async () => {
    const response = await fetch(`${base}/admin/shipping-providers`, {
      headers: { Authorization: 'Bearer admin-token' },
    });
    expect(response.status).toBe(HttpStatus.OK);
    expect(await response.json()).toEqual([]);
  });
});
