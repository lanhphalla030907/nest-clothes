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
import { CreatePromotionDto } from '../../promotions/dto/create-promotion.dto.js';
import { PromotionListQueryDto } from '../../promotions/dto/promotion-list-query.dto.js';
import { PromotionListResponseDto } from '../../promotions/dto/promotion-list-response.dto.js';
import { PromotionResponseDto } from '../../promotions/dto/promotion-response.dto.js';
import { PromotionUsageListQueryDto } from '../../promotions/dto/promotion-usage-list-query.dto.js';
import { PromotionUsageListResponseDto } from '../../promotions/dto/promotion-usage-list-response.dto.js';
import { UpdatePromotionDto } from '../../promotions/dto/update-promotion.dto.js';
import { PromotionsService } from '../../promotions/promotions.service.js';
import { AdminPromotionsController } from './admin-promotions.controller.js';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';
const PROMOTION_ID = '33333333-3333-4333-8333-333333333333';

const buildPromotion = (
  overrides: Partial<PromotionResponseDto> = {},
): PromotionResponseDto =>
  Object.assign(new PromotionResponseDto(), {
    id: PROMOTION_ID,
    code: 'SAVE10',
    name: 'Save 10%',
    description: null,
    kind: 'COUPON',
    discountType: 'PERCENTAGE',
    percentOff: '10.00',
    amountOff: null,
    minSubtotal: '0.00',
    maxDiscount: null,
    startsAt: null,
    endsAt: null,
    isActive: true,
    usageLimitTotal: null,
    usageLimitPerUser: null,
    priority: 0,
    archivedAt: null,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
    ...overrides,
  });

const buildPage = (
  items: PromotionResponseDto[] = [buildPromotion()],
): PromotionListResponseDto => ({
  items,
  pagination: {
    page: 1,
    limit: 20,
    total: items.length,
    totalPages: items.length > 0 ? 1 : 0,
  },
});

const buildUsagePage = (): PromotionUsageListResponseDto => ({
  items: [
    {
      id: 'usage-1',
      promotionId: PROMOTION_ID,
      orderId: 'order-1',
      orderNumber: 'ORD-1',
      userId: 'user-1',
      user: {
        id: 'user-1',
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada@example.test',
      },
      order: {
        id: 'order-1',
        orderNumber: 'ORD-1',
      },
      codeSnapshot: 'SAVE10',
      nameSnapshot: 'Save 10%',
      discountType: 'PERCENTAGE',
      percentOff: '10.00',
      amountOff: null,
      discountAmount: '5.00',
      subtotalAtUse: '50.00',
      createdAt: new Date('2026-11-06T00:00:00.000Z'),
    },
  ],
  pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
});

type ServiceMock = {
  list: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  findById: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  activate: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  archive: ReturnType<typeof vi.fn>;
  listUsages: ReturnType<typeof vi.fn>;
};

const createServiceMock = (): ServiceMock => ({
  list: vi.fn(),
  create: vi.fn(),
  findById: vi.fn(),
  update: vi.fn(),
  activate: vi.fn(),
  pause: vi.fn(),
  archive: vi.fn(),
  listUsages: vi.fn(),
});

describe('AdminPromotionsController', () => {
  let controller: AdminPromotionsController;
  let service: ServiceMock;

  beforeEach(async () => {
    service = createServiceMock();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminPromotionsController],
      providers: [
        { provide: PromotionsService, useValue: service },
        JwtAuthGuard,
        RolesGuard,
        { provide: AccessTokenService, useValue: { verify: vi.fn() } },
        { provide: UsersRepository, useValue: { findById: vi.fn() } },
      ],
    }).compile();
    controller = module.get(AdminPromotionsController);
  });

  it('requires JWT authentication followed by the ADMIN role guard', () => {
    expect(
      Reflect.getMetadata('__guards__', AdminPromotionsController),
    ).toEqual([JwtAuthGuard, RolesGuard]);
    expect(Reflect.getMetadata(ROLES_KEY, AdminPromotionsController)).toEqual([
      Role.ADMIN,
    ]);
  });

  it('delegates list requests and pagination to the promotion service', async () => {
    const query = Object.assign(new PromotionListQueryDto(), {
      page: 2,
      limit: 10,
      kind: 'COUPON',
      isActive: true,
      archived: false,
    });
    const expected = buildPage();
    service.list.mockResolvedValue(expected);

    const result = await controller.list(query);

    expect(result).toBe(expected);
    expect(service.list).toHaveBeenCalledTimes(1);
    expect(service.list).toHaveBeenCalledWith(query);
  });

  it('delegates create requests to the promotion service', async () => {
    const dto = Object.assign(new CreatePromotionDto(), {
      code: 'SAVE10',
      name: 'Save 10%',
      kind: 'COUPON',
      discountType: 'PERCENTAGE',
      percentOff: '10.00',
    });
    const expected = buildPromotion();
    service.create.mockResolvedValue(expected);

    const result = await controller.create(dto);

    expect(result).toBe(expected);
    expect(service.create).toHaveBeenCalledTimes(1);
    expect(service.create).toHaveBeenCalledWith(dto);
  });

  it('delegates update requests to the promotion service', async () => {
    const dto = Object.assign(new UpdatePromotionDto(), { name: 'Renamed' });
    const expected = buildPromotion({ name: 'Renamed' });
    service.update.mockResolvedValue(expected);

    const result = await controller.update(PROMOTION_ID, dto);

    expect(result).toBe(expected);
    expect(service.update).toHaveBeenCalledTimes(1);
    expect(service.update).toHaveBeenCalledWith(PROMOTION_ID, dto);
  });

  it('delegates find, activate, pause, and archive to the promotion service', async () => {
    const expected = buildPromotion();
    service.findById.mockResolvedValue(expected);
    service.activate.mockResolvedValue(expected);
    service.pause.mockResolvedValue(buildPromotion({ isActive: false }));
    service.archive.mockResolvedValue(
      buildPromotion({ isActive: false, archivedAt: new Date() }),
    );

    await expect(controller.findOne(PROMOTION_ID)).resolves.toBe(expected);
    await expect(controller.activate(PROMOTION_ID)).resolves.toBe(expected);
    await expect(controller.pause(PROMOTION_ID)).resolves.toEqual(
      expect.objectContaining({ isActive: false }),
    );
    await expect(controller.archive(PROMOTION_ID)).resolves.toEqual(
      expect.objectContaining({ archivedAt: expect.any(Date) }),
    );

    expect(service.findById).toHaveBeenCalledWith(PROMOTION_ID);
    expect(service.activate).toHaveBeenCalledWith(PROMOTION_ID);
    expect(service.pause).toHaveBeenCalledWith(PROMOTION_ID);
    expect(service.archive).toHaveBeenCalledWith(PROMOTION_ID);
  });

  it('delegates usage history requests to the promotion service', async () => {
    const query = Object.assign(new PromotionUsageListQueryDto(), {
      page: 1,
      limit: 20,
    });
    const expected = buildUsagePage();
    service.listUsages.mockResolvedValue(expected);

    const result = await controller.usages(PROMOTION_ID, query);

    expect(result).toBe(expected);
    expect(service.listUsages).toHaveBeenCalledTimes(1);
    expect(service.listUsages).toHaveBeenCalledWith(PROMOTION_ID, query);
  });

  it('propagates service errors unchanged', async () => {
    const notFound = new NotFoundException('Promotion not found');
    service.findById.mockRejectedValue(notFound);

    await expect(controller.findOne(PROMOTION_ID)).rejects.toBe(notFound);
  });
});

describe('AdminPromotionsController authorization (HTTP)', () => {
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
    service.list.mockResolvedValue(buildPage());
    service.create.mockResolvedValue(buildPromotion());
    service.findById.mockResolvedValue(buildPromotion());
    service.update.mockResolvedValue(buildPromotion({ name: 'Renamed' }));
    service.activate.mockResolvedValue(buildPromotion());
    service.pause.mockResolvedValue(buildPromotion({ isActive: false }));
    service.archive.mockResolvedValue(
      buildPromotion({ isActive: false, archivedAt: new Date() }),
    );
    service.listUsages.mockResolvedValue(buildUsagePage());

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminPromotionsController],
      providers: [
        { provide: PromotionsService, useValue: service },
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
    service.list.mockResolvedValue(buildPage());
    service.listUsages.mockResolvedValue(buildUsagePage());
  });

  it('rejects unauthenticated requests', async () => {
    const response = await fetch(`${base}/admin/promotions`);

    expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
  });

  it('rejects authenticated non-admin requests', async () => {
    const response = await fetch(`${base}/admin/promotions`, {
      headers: { Authorization: 'Bearer customer-token' },
    });

    expect(response.status).toBe(HttpStatus.FORBIDDEN);
    expect(service.list).not.toHaveBeenCalled();
  });

  it('allows admins to list promotions with filters and pagination', async () => {
    const response = await fetch(
      `${base}/admin/promotions?page=2&limit=10&kind=COUPON&isActive=false&archived=true`,
      { headers: { Authorization: 'Bearer admin-token' } },
    );

    expect(response.status).toBe(HttpStatus.OK);
    expect(await response.json()).toMatchObject({
      pagination: { page: 1, limit: 20 },
    });
    expect(service.list).toHaveBeenCalledWith(
      expect.objectContaining({
        page: 2,
        limit: 10,
        kind: 'COUPON',
        isActive: false,
        archived: true,
      }),
    );
  });

  it('allows admins to create a promotion', async () => {
    const response = await fetch(`${base}/admin/promotions`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Save 10%',
        kind: 'COUPON',
        discountType: 'PERCENTAGE',
        code: 'save10',
        percentOff: '10.00',
      }),
    });

    expect(response.status).toBe(HttpStatus.CREATED);
    expect(service.create).toHaveBeenCalledTimes(1);
    expect(service.create.mock.calls[0][0]).toMatchObject({
      name: 'Save 10%',
      kind: 'COUPON',
      discountType: 'PERCENTAGE',
      code: 'SAVE10',
      percentOff: '10.00',
    });
  });

  it('allows admins to update, activate, pause, archive, and read usages', async () => {
    const headers = {
      Authorization: 'Bearer admin-token',
      'Content-Type': 'application/json',
    };

    const update = await fetch(`${base}/admin/promotions/${PROMOTION_ID}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ name: 'Renamed' }),
    });
    expect(update.status).toBe(HttpStatus.OK);

    const activate = await fetch(
      `${base}/admin/promotions/${PROMOTION_ID}/activate`,
      { method: 'POST', headers },
    );
    expect(activate.status).toBe(HttpStatus.OK);

    const pause = await fetch(
      `${base}/admin/promotions/${PROMOTION_ID}/pause`,
      { method: 'POST', headers },
    );
    expect(pause.status).toBe(HttpStatus.OK);

    const archive = await fetch(
      `${base}/admin/promotions/${PROMOTION_ID}/archive`,
      { method: 'POST', headers },
    );
    expect(archive.status).toBe(HttpStatus.OK);

    const usages = await fetch(
      `${base}/admin/promotions/${PROMOTION_ID}/usages?page=1&limit=20`,
      { headers },
    );
    expect(usages.status).toBe(HttpStatus.OK);

    expect(service.update).toHaveBeenCalledWith(
      PROMOTION_ID,
      expect.objectContaining({ name: 'Renamed' }),
    );
    expect(service.activate).toHaveBeenCalledWith(PROMOTION_ID);
    expect(service.pause).toHaveBeenCalledWith(PROMOTION_ID);
    expect(service.archive).toHaveBeenCalledWith(PROMOTION_ID);
    expect(service.listUsages).toHaveBeenCalledWith(
      PROMOTION_ID,
      expect.objectContaining({ page: 1, limit: 20 }),
    );
  });

  it('propagates service failures as HTTP errors', async () => {
    service.list.mockRejectedValue(
      new BadRequestException('Invalid promotion filter'),
    );

    const response = await fetch(`${base}/admin/promotions`, {
      headers: { Authorization: 'Bearer admin-token' },
    });

    expect(response.status).toBe(HttpStatus.BAD_REQUEST);
  });
});
