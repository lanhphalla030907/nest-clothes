import 'reflect-metadata';
import {
  BadRequestException,
  HttpStatus,
  NotFoundException,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TestIdentityRegistry } from '../../test/support/auth-fixtures.js';
import { ROLES_KEY } from '../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { Role } from '../generated/prisma/enums.js';
import { FeedbackController } from './feedback.controller.js';
import { AdminFeedbackController } from './admin-feedback.controller.js';
import { PublicFeedbackController } from './public-feedback.controller.js';
import { FeedbackService } from './feedback.service.js';

const CUSTOMER_A_ID = 'a1b2c3d4-e5f6-4a1b-8c9d-0e1f2a3b4c5d';
const CUSTOMER_B_ID = 'b2c3d4e5-f6a7-4b2c-9d0e-1f2a3b4c5d6e';
const ADMIN_ID = 'c3d4e5f6-a7b8-4c3d-a0e1-2f3a4b5c6d7e';

const FEEDBACK_ID = 'd4e5f6a7-b8c9-4d5e-9f0a-1b2c3d4e5f6a';

const feedbackResponse = {
  id: FEEDBACK_ID,
  customerId: CUSTOMER_A_ID,
  title: 'Packaging was lovely',
  message: 'The recyclable wrapping is a nice touch.',
  status: 'UNPUBLISHED',
  createdAt: new Date('2026-01-10T09:00:00.000Z'),
  updatedAt: new Date('2026-01-10T09:00:00.000Z'),
};

const responses = {
  create: feedbackResponse,
  findCustomerPage: {
    items: [feedbackResponse],
    page: 1,
    limit: 20,
    total: 1,
    totalPages: 1,
  },
  findCustomerById: feedbackResponse,
  update: { ...feedbackResponse, title: 'Packaging was gorgeous' },
  findAdminPage: {
    items: [feedbackResponse],
    pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
  },
  createForAdmin: feedbackResponse,
  findAdminById: feedbackResponse,
  updateAdmin: { ...feedbackResponse, status: 'PUBLISHED' },
  setStatus: { ...feedbackResponse, status: 'PUBLISHED' },
  findPublished: {
    items: [{ ...feedbackResponse, customerId: undefined }],
    page: 1,
    limit: 20,
    total: 1,
    totalPages: 1,
  },
};

function makeService() {
  return {
    createForCustomer: vi.fn().mockResolvedValue(responses.create),
    findCustomerPage: vi.fn().mockResolvedValue(responses.findCustomerPage),
    findCustomerById: vi.fn().mockResolvedValue(responses.findCustomerById),
    updateForCustomer: vi.fn().mockResolvedValue(responses.update),
    deleteForCustomer: vi.fn().mockResolvedValue(undefined),
    findAdminPage: vi.fn().mockResolvedValue(responses.findAdminPage),
    createForAdmin: vi.fn().mockResolvedValue(responses.createForAdmin),
    findAdminById: vi.fn().mockResolvedValue(responses.findAdminById),
    updateAdmin: vi.fn().mockResolvedValue(responses.updateAdmin),
    deleteAdmin: vi.fn().mockResolvedValue(undefined),
    setStatus: vi.fn().mockResolvedValue(responses.setStatus),
    findPublishedPage: vi.fn().mockResolvedValue(responses.findPublished),
  };
}

/** Boots one controller with a stubbed service and the real guards + pipe. */
function setupApp(
  identities: TestIdentityRegistry,
  controllers: unknown[],
  service: ReturnType<typeof makeService>,
): { getBase: () => string } {
  let app: INestApplication;
  let base = '';

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: controllers as never[],
      providers: [
        ...identities.providers(),
        { provide: FeedbackService, useValue: service },
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
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  return { getBase: () => base };
}

const withAuth = (registry: TestIdentityRegistry, userId?: string) =>
  userId === undefined ? {} : registry.bearerHeaderFor(userId);

const request = (getBase: () => string, registry: TestIdentityRegistry) =>
  async (
    method: string,
    path: string,
    userId?: string,
    body?: unknown,
  ): Promise<Response> => {
    const headers: Record<string, string> = withAuth(registry, userId);
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return await fetch(`${getBase()}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  };

describe('FeedbackController authorization', () => {
  it('requires JWT authentication and no role', () => {
    expect(Reflect.getMetadata('__guards__', FeedbackController)).toEqual([
      JwtAuthGuard,
    ]);
  });
});

describe('AdminFeedbackController authorization', () => {
  it('requires JWT authentication followed by the ADMIN role guard', () => {
    expect(Reflect.getMetadata('__guards__', AdminFeedbackController)).toEqual([
      JwtAuthGuard,
      RolesGuard,
    ]);
    expect(Reflect.getMetadata(ROLES_KEY, AdminFeedbackController)).toEqual([
      Role.ADMIN,
    ]);
  });
});

describe('PublicFeedbackController authorization', () => {
  it('requires no authentication', () => {
    expect(Reflect.getMetadata('__guards__', PublicFeedbackController)).toEqual(
      undefined,
    );
  });
});

describe('Customer feedback (HTTP)', () => {
  const identities = new TestIdentityRegistry();
  identities.register({ id: CUSTOMER_A_ID, email: 'a@example.test', role: Role.CUSTOMER });
  identities.register({ id: CUSTOMER_B_ID, email: 'b@example.test', role: Role.CUSTOMER });

  const service = makeService();
  const { getBase } = setupApp(identities, [FeedbackController], service);
  const fetch = request(getBase, identities);

  beforeEach(() => {
    vi.clearAllMocks();
    service.createForCustomer.mockResolvedValue(responses.create);
    service.findCustomerPage.mockResolvedValue(responses.findCustomerPage);
    service.findCustomerById.mockResolvedValue(responses.findCustomerById);
    service.updateForCustomer.mockResolvedValue(responses.update);
    service.deleteForCustomer.mockResolvedValue(undefined);
  });

  it('creates feedback for the authenticated customer only', async () => {
    const res = await fetch('POST', '/feedback', CUSTOMER_A_ID, {
      title: 'Packaging was lovely',
      message: 'The recyclable wrapping is a nice touch.',
    });

    expect(res.status).toBe(HttpStatus.CREATED);
    expect(service.createForCustomer).toHaveBeenCalledWith(CUSTOMER_A_ID, {
      title: 'Packaging was lovely',
      message: 'The recyclable wrapping is a nice touch.',
    });
  });

  it('rejects a missing title with 400', async () => {
    const res = await fetch('POST', '/feedback', CUSTOMER_A_ID, {
      message: 'No title.',
    });

    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(service.createForCustomer).not.toHaveBeenCalled();
  });

  it('rejects a blank message with 400', async () => {
    const res = await fetch('POST', '/feedback', CUSTOMER_A_ID, {
      title: 'Fine',
      message: '   ',
    });

    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(service.createForCustomer).not.toHaveBeenCalled();
  });

  it('lists the authenticated customer\'s own feedback', async () => {
    const res = await fetch('GET', '/feedback', CUSTOMER_A_ID);

    expect(res.status).toBe(HttpStatus.OK);
    expect(service.findCustomerPage).toHaveBeenCalledWith(
      CUSTOMER_A_ID,
      expect.anything(),
    );
  });

  it('reads only its own feedback', async () => {
    const res = await fetch('GET', `/feedback/${FEEDBACK_ID}`, CUSTOMER_A_ID);

    expect(res.status).toBe(HttpStatus.OK);
    expect(service.findCustomerById).toHaveBeenCalledWith(FEEDBACK_ID, CUSTOMER_A_ID);
  });

  it('cannot read another customer\'s feedback', async () => {
    service.findCustomerById.mockRejectedValue(
      new NotFoundException('Feedback does not exist'),
    );

    const res = await fetch('GET', `/feedback/${FEEDBACK_ID}`, CUSTOMER_B_ID);

    expect(res.status).toBe(HttpStatus.NOT_FOUND);
    expect(service.findCustomerById).toHaveBeenCalledWith(FEEDBACK_ID, CUSTOMER_B_ID);
  });

  it('updates only its own feedback', async () => {
    const res = await fetch('PATCH', `/feedback/${FEEDBACK_ID}`, CUSTOMER_A_ID, {
      title: 'Packaging was gorgeous',
    });

    expect(res.status).toBe(HttpStatus.OK);
    expect(service.updateForCustomer).toHaveBeenCalledWith(
      FEEDBACK_ID,
      CUSTOMER_A_ID,
      { title: 'Packaging was gorgeous' },
    );
  });

  it('cannot update another customer\'s feedback', async () => {
    service.updateForCustomer.mockRejectedValue(
      new NotFoundException('Feedback does not exist'),
    );

    const res = await fetch('PATCH', `/feedback/${FEEDBACK_ID}`, CUSTOMER_B_ID, {
      title: 'Hacked',
    });

    expect(res.status).toBe(HttpStatus.NOT_FOUND);
    expect(service.updateForCustomer).toHaveBeenCalledWith(
      FEEDBACK_ID,
      CUSTOMER_B_ID,
      { title: 'Hacked' },
    );
  });

  it('deletes only its own feedback', async () => {
    const res = await fetch('DELETE', `/feedback/${FEEDBACK_ID}`, CUSTOMER_A_ID);

    expect(res.status).toBe(HttpStatus.NO_CONTENT);
    expect(service.deleteForCustomer).toHaveBeenCalledWith(FEEDBACK_ID, CUSTOMER_A_ID);
  });

  it('cannot delete another customer\'s feedback', async () => {
    service.deleteForCustomer.mockRejectedValue(
      new NotFoundException('Feedback does not exist'),
    );

    const res = await fetch('DELETE', `/feedback/${FEEDBACK_ID}`, CUSTOMER_B_ID);

    expect(res.status).toBe(HttpStatus.NOT_FOUND);
    expect(service.deleteForCustomer).toHaveBeenCalledWith(FEEDBACK_ID, CUSTOMER_B_ID);
  });

  it('refuses an unauthenticated caller with 401', async () => {
    const res = await fetch('GET', '/feedback');

    expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
  });

  it('rejects a malformed id with 400', async () => {
    const res = await fetch('GET', '/feedback/not-a-uuid', CUSTOMER_A_ID);

    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(service.findCustomerById).not.toHaveBeenCalled();
  });
});

describe('Admin feedback management (HTTP)', () => {
  const identities = new TestIdentityRegistry();
  identities.register({ id: ADMIN_ID, email: 'admin@example.test', role: Role.ADMIN });
  identities.register({ id: CUSTOMER_A_ID, email: 'a@example.test', role: Role.CUSTOMER });

  const service = makeService();
  const { getBase } = setupApp(identities, [AdminFeedbackController], service);
  const fetch = request(getBase, identities);

  beforeEach(() => {
    vi.clearAllMocks();
    service.findAdminPage.mockResolvedValue(responses.findAdminPage);
    service.createForAdmin.mockResolvedValue(responses.createForAdmin);
    service.findAdminById.mockResolvedValue(responses.findAdminById);
    service.updateAdmin.mockResolvedValue(responses.updateAdmin);
    service.deleteAdmin.mockResolvedValue(undefined);
    service.setStatus.mockResolvedValue(responses.setStatus);
  });

  it('lists all feedback for an administrator', async () => {
    const res = await fetch('GET', '/admin/feedback', ADMIN_ID);

    expect(res.status).toBe(HttpStatus.OK);
    expect(service.findAdminPage).toHaveBeenCalledOnce();
  });

  it('creates feedback for the selected customer account', async () => {
    const res = await fetch('POST', '/admin/feedback', ADMIN_ID, {
      customerId: CUSTOMER_A_ID,
      title: 'Lovely shop',
      message: 'Great service.',
    });

    expect(res.status).toBe(HttpStatus.CREATED);
    expect(service.createForAdmin).toHaveBeenCalledWith({
      customerId: CUSTOMER_A_ID,
      title: 'Lovely shop',
      message: 'Great service.',
    });
  });

  it('refuses a non-customer account with 400', async () => {
    service.createForAdmin.mockRejectedValue(
      new BadRequestException('Feedback can only be created for a customer account.'),
    );

    const res = await fetch('POST', '/admin/feedback', ADMIN_ID, {
      customerId: ADMIN_ID,
      title: 'Lovely shop',
      message: 'Great service.',
    });

    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(service.createForAdmin).toHaveBeenCalledWith({
      customerId: ADMIN_ID,
      title: 'Lovely shop',
      message: 'Great service.',
    });
  });

  it('refuses a missing customer with 404', async () => {
    service.createForAdmin.mockRejectedValue(
      new NotFoundException('Customer does not exist'),
    );

    const res = await fetch('POST', '/admin/feedback', ADMIN_ID, {
      customerId: '00000000-0000-0000-0000-000000000000',
      title: 'Lovely shop',
      message: 'Great service.',
    });

    expect(res.status).toBe(HttpStatus.NOT_FOUND);
  });

  it('publishes and unpublishes feedback', async () => {
    const res = await fetch(
      'PATCH',
      `/admin/feedback/${FEEDBACK_ID}/status`,
      ADMIN_ID,
      { status: 'PUBLISHED' },
    );

    expect(res.status).toBe(HttpStatus.OK);
    expect(service.setStatus).toHaveBeenCalledWith(FEEDBACK_ID, {
      status: 'PUBLISHED',
    });
  });

  it('refuses an unauthenticated caller with 401', async () => {
    const res = await fetch('GET', '/admin/feedback');

    expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
  });

  it('refuses a customer with 403', async () => {
    const res = await fetch('GET', '/admin/feedback', CUSTOMER_A_ID);

    expect(res.status).toBe(HttpStatus.FORBIDDEN);
  });
});

describe('Public feedback (HTTP)', () => {
  const service = makeService();
  const { getBase } = setupApp(new TestIdentityRegistry(), [PublicFeedbackController], service);
  const fetch = request(getBase, new TestIdentityRegistry());

  beforeEach(() => {
    vi.clearAllMocks();
    service.findPublishedPage.mockResolvedValue(responses.findPublished);
  });

  it('lists published feedback without authentication', async () => {
    const res = await fetch('GET', '/feedback/public');

    expect(res.status).toBe(HttpStatus.OK);
    expect(service.findPublishedPage).toHaveBeenCalledOnce();
  });
});

describe('Cross-controller route conflict (HTTP)', () => {
  const identities = new TestIdentityRegistry();
  identities.register({ id: CUSTOMER_A_ID, email: 'a@example.test', role: Role.CUSTOMER });

  const service = makeService();
  const { getBase } = setupApp(
    identities,
    [PublicFeedbackController, FeedbackController],
    service,
  );
  const fetch = request(getBase, identities);

  beforeEach(() => {
    vi.clearAllMocks();
    service.findPublishedPage.mockResolvedValue(responses.findPublished);
    service.findCustomerPage.mockResolvedValue(responses.findCustomerPage);
  });

  it('routes GET /feedback/public to PublicFeedbackController, not FeedbackController/:id', async () => {
    const res = await fetch('GET', '/feedback/public');

    expect(res.status).toBe(HttpStatus.OK);
    expect(service.findPublishedPage).toHaveBeenCalledOnce();
    expect(service.findCustomerById).not.toHaveBeenCalled();
  });

  it('still routes GET /feedback to FeedbackController', async () => {
    const res = await fetch('GET', '/feedback', CUSTOMER_A_ID);

    expect(res.status).toBe(HttpStatus.OK);
    expect(service.findCustomerPage).toHaveBeenCalledWith(CUSTOMER_A_ID, expect.anything());
    expect(service.findPublishedPage).not.toHaveBeenCalled();
  });

  it('rejects a non-UUID id on /feedback/:id with 400', async () => {
    const res = await fetch('GET', '/feedback/not-a-uuid', CUSTOMER_A_ID);

    expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    expect(service.findCustomerById).not.toHaveBeenCalled();
  });
});
