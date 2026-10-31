import {
  HttpStatus,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TestIdentityRegistry } from '../../test/support/auth-fixtures.js';
import { Role } from '../generated/prisma/enums.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { DeliveryService } from './delivery.service.js';
import { DeliveryManagerController } from './delivery-manager.controller.js';

const MANAGER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ADMIN_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const INACTIVE_MANAGER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const INACTIVE_ADMIN_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const STAFF_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const CUSTOMER_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const ORDER_ID = '11111111-1111-4111-8111-111111111111';

type ManagerServiceMethod = keyof Pick<
  DeliveryService,
  | 'listDeliveryOrders'
  | 'getOrderDeliveryDetails'
  | 'assignDelivery'
  | 'reassignDelivery'
>;

interface ManagerEndpoint {
  name: string;
  method: 'GET' | 'POST';
  path: string;
  body?: Record<string, unknown>;
  serviceMethod: ManagerServiceMethod;
}

const endpoints: ManagerEndpoint[] = [
  {
    name: 'list delivery orders',
    method: 'GET',
    path: '/delivery/manager/orders',
    serviceMethod: 'listDeliveryOrders',
  },
  {
    name: 'get order delivery details',
    method: 'GET',
    path: `/delivery/manager/orders/${ORDER_ID}`,
    serviceMethod: 'getOrderDeliveryDetails',
  },
  {
    name: 'assign delivery',
    method: 'POST',
    path: '/delivery/manager/assign',
    body: { orderId: ORDER_ID, deliveryStaffId: STAFF_ID },
    serviceMethod: 'assignDelivery',
  },
  {
    name: 'reassign delivery',
    method: 'POST',
    path: `/delivery/manager/orders/${ORDER_ID}/reassign`,
    body: { deliveryStaffId: STAFF_ID },
    serviceMethod: 'reassignDelivery',
  },
];

interface IdentityCase {
  label: string;
  id: string;
  expectedStatus: number;
}

const identityCases: IdentityCase[] = [
  {
    label: 'active DELIVERY_MANAGER',
    id: MANAGER_ID,
    expectedStatus: HttpStatus.OK,
  },
  { label: 'active ADMIN', id: ADMIN_ID, expectedStatus: HttpStatus.OK },
  {
    label: 'inactive DELIVERY_MANAGER',
    id: INACTIVE_MANAGER_ID,
    expectedStatus: HttpStatus.UNAUTHORIZED,
  },
  {
    label: 'inactive ADMIN',
    id: INACTIVE_ADMIN_ID,
    expectedStatus: HttpStatus.UNAUTHORIZED,
  },
  {
    label: 'DELIVERY_STAFF',
    id: STAFF_ID,
    expectedStatus: HttpStatus.FORBIDDEN,
  },
  {
    label: 'CUSTOMER',
    id: CUSTOMER_ID,
    expectedStatus: HttpStatus.FORBIDDEN,
  },
];

describe('DeliveryManagerController authorization (HTTP)', () => {
  let app: INestApplication;
  let base: string;
  let identities: TestIdentityRegistry;

  const service = {
    listDeliveryOrders: vi.fn().mockResolvedValue({ items: [] }),
    getOrderDeliveryDetails: vi.fn().mockResolvedValue({ id: ORDER_ID }),
    assignDelivery: vi.fn().mockResolvedValue({ id: 'assignment-1' }),
    reassignDelivery: vi.fn().mockResolvedValue({ id: 'assignment-1' }),
  };

  const request = (
    endpoint: ManagerEndpoint,
    userId?: string,
  ): Promise<Response> =>
    fetch(`${base}${endpoint.path}`, {
      method: endpoint.method,
      headers: {
        ...(userId === undefined ? {} : identities.bearerHeaderFor(userId)),
        ...(endpoint.body === undefined
          ? {}
          : { 'Content-Type': 'application/json' }),
      },
      body: endpoint.body === undefined ? undefined : JSON.stringify(endpoint.body),
    });

  beforeAll(async () => {
    identities = new TestIdentityRegistry();
    identities.register({
      id: MANAGER_ID,
      email: 'manager@example.test',
      role: Role.DELIVERY_MANAGER,
    });
    identities.register({
      id: ADMIN_ID,
      email: 'admin@example.test',
      role: Role.ADMIN,
    });
    identities.register(
      {
        id: INACTIVE_MANAGER_ID,
        email: 'inactive-manager@example.test',
        role: Role.DELIVERY_MANAGER,
      },
      { status: 'INACTIVE' },
    );
    identities.register(
      {
        id: INACTIVE_ADMIN_ID,
        email: 'inactive-admin@example.test',
        role: Role.ADMIN,
      },
      { status: 'INACTIVE' },
    );
    identities.register({
      id: STAFF_ID,
      email: 'staff@example.test',
      role: Role.DELIVERY_STAFF,
    });
    identities.register({
      id: CUSTOMER_ID,
      email: 'customer@example.test',
      role: Role.CUSTOMER,
    });

    const module: TestingModule = await Test.createTestingModule({
      controllers: [DeliveryManagerController],
      providers: [
        { provide: DeliveryService, useValue: service },
        ...identities.providers(),
        JwtAuthGuard,
        RolesGuard,
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

  beforeEach(() => {
    vi.clearAllMocks();
  });

  for (const endpoint of endpoints) {
    describe(endpoint.name, () => {
      it.each(
        identityCases.map((identity) => [
          identity.label,
          identity.id,
          identity.expectedStatus,
        ] as const),
      )('answers %s with %i', async (_label, userId, expectedStatus) => {
        const response = await request(endpoint, userId);
        const successStatus =
          endpoint.method === 'POST' ? HttpStatus.CREATED : HttpStatus.OK;
        const expectedResponseStatus =
          expectedStatus === HttpStatus.OK ? successStatus : expectedStatus;

        expect(response.status).toBe(expectedResponseStatus);

        if (expectedStatus === HttpStatus.OK) {
          expect(service[endpoint.serviceMethod]).toHaveBeenCalledOnce();
        } else {
          expect(service[endpoint.serviceMethod]).not.toHaveBeenCalled();
        }
      });

      it('answers 401 when no token is presented', async () => {
        const response = await request(endpoint);

        expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
        expect(service[endpoint.serviceMethod]).not.toHaveBeenCalled();
      });
    });
  }
});
