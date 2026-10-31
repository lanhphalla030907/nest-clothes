import {
  HttpStatus,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TestIdentityRegistry } from '../../test/support/auth-fixtures.js';
import { DeliveryStatus, Role } from '../generated/prisma/enums.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { DeliveryService } from './delivery.service.js';
import { DeliveryStaffController } from './delivery-staff.controller.js';

const STAFF_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const INACTIVE_STAFF_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ADMIN_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MANAGER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CUSTOMER_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const ASSIGNMENT_ID = '11111111-1111-4111-8111-111111111111';

type StaffServiceMethod = keyof Pick<
  DeliveryService,
  | 'getMyAssignments'
  | 'getMyAssignment'
  | 'updateMyAssignmentStatus'
  | 'collectCod'
>;

interface StaffEndpoint {
  name: string;
  method: 'GET' | 'PATCH' | 'POST';
  path: string;
  body?: Record<string, unknown>;
  serviceMethod: StaffServiceMethod;
  successStatus?: number;
}

const endpoints: StaffEndpoint[] = [
  {
    name: 'list my assignments',
    method: 'GET',
    path: '/delivery/staff/assignments',
    serviceMethod: 'getMyAssignments',
  },
  {
    name: 'get my assignment details',
    method: 'GET',
    path: `/delivery/staff/assignments/${ASSIGNMENT_ID}`,
    serviceMethod: 'getMyAssignment',
  },
  {
    name: 'update my assignment status',
    method: 'PATCH',
    path: `/delivery/staff/assignments/${ASSIGNMENT_ID}/status`,
    body: { status: DeliveryStatus.OUT_FOR_DELIVERY },
    serviceMethod: 'updateMyAssignmentStatus',
  },
  {
    name: 'collect COD for my assignment',
    method: 'POST',
    path: `/delivery/staff/assignments/${ASSIGNMENT_ID}/collect-cod`,
    body: { amount: '10.00', currency: 'USD' },
    serviceMethod: 'collectCod',
    successStatus: HttpStatus.CREATED,
  },
];

interface IdentityCase {
  label: string;
  id: string;
  expectedStatus: number;
}

const identityCases: IdentityCase[] = [
  {
    label: 'active DELIVERY_STAFF',
    id: STAFF_ID,
    expectedStatus: HttpStatus.OK,
  },
  {
    label: 'inactive DELIVERY_STAFF',
    id: INACTIVE_STAFF_ID,
    expectedStatus: HttpStatus.UNAUTHORIZED,
  },
  { label: 'ADMIN', id: ADMIN_ID, expectedStatus: HttpStatus.FORBIDDEN },
  {
    label: 'DELIVERY_MANAGER',
    id: MANAGER_ID,
    expectedStatus: HttpStatus.FORBIDDEN,
  },
  {
    label: 'CUSTOMER',
    id: CUSTOMER_ID,
    expectedStatus: HttpStatus.FORBIDDEN,
  },
];

describe('DeliveryStaffController authorization (HTTP)', () => {
  let app: INestApplication;
  let base: string;
  let identities: TestIdentityRegistry;

  const service = {
    getMyAssignments: vi.fn().mockResolvedValue({ items: [] }),
    getMyAssignment: vi.fn().mockResolvedValue({ id: ASSIGNMENT_ID }),
    updateMyAssignmentStatus: vi
      .fn()
      .mockResolvedValue({ id: ASSIGNMENT_ID }),
    collectCod: vi.fn().mockResolvedValue({ id: ASSIGNMENT_ID }),
  };

  const request = (
    endpoint: StaffEndpoint,
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
      id: STAFF_ID,
      email: 'staff@example.test',
      role: Role.DELIVERY_STAFF,
    });
    identities.register(
      {
        id: INACTIVE_STAFF_ID,
        email: 'inactive-staff@example.test',
        role: Role.DELIVERY_STAFF,
      },
      { status: 'INACTIVE' },
    );
    identities.register({
      id: ADMIN_ID,
      email: 'admin@example.test',
      role: Role.ADMIN,
    });
    identities.register({
      id: MANAGER_ID,
      email: 'manager@example.test',
      role: Role.DELIVERY_MANAGER,
    });
    identities.register({
      id: CUSTOMER_ID,
      email: 'customer@example.test',
      role: Role.CUSTOMER,
    });

    const module: TestingModule = await Test.createTestingModule({
      controllers: [DeliveryStaffController],
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

        const expected =
          expectedStatus === HttpStatus.OK
            ? (endpoint.successStatus ?? HttpStatus.OK)
            : expectedStatus;

        expect(response.status).toBe(expected);

        if (expected === (endpoint.successStatus ?? HttpStatus.OK)) {
          expect(service[endpoint.serviceMethod]).toHaveBeenCalledOnce();
          expect(
            service[endpoint.serviceMethod].mock.calls[0]?.[0],
          ).toBe(STAFF_ID);
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
