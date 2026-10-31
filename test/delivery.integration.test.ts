import 'dotenv/config';
import {
  HttpStatus,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module.js';
import {
  DeliveryStatus,
  Role,
} from '../src/generated/prisma/enums.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import {
  bearerHeaders,
  tokenIssuerFor,
  type IssueToken,
} from './support/e2e-auth.js';

/**
 * Delivery workflows against a **real PostgreSQL** database.
 *
 * The unit spec proves the branch logic with a stubbed repository. This file
 * proves the parts only PostgreSQL can:
 *
 * - the `orders` row lock serialises two managers assigning the same order, and
 *   the partial unique index is the final guard if application logic is bypassed;
 * - reassignment ends the previous row in the same transaction that inserts the
 *   next one, so a failed insert leaves no half-finished history;
 * - the assignment lifecycle transitions are enforced by the API;
 * - staff can read only their own assignment, and roles that are not explicitly
 *   granted a delivery endpoint are refused.
 *
 * Fixtures are namespaced by a per-run token and removed in `afterAll`. The
 * dedicated Vitest config points `DATABASE_URL` at an isolated `*_test`
 * database, so this cleanup can never reach development data.
 */
describe('Delivery (PostgreSQL)', () => {
  const run = randomUUID().slice(0, 8);
  const FAILURE_TRIGGER = 'delivery_test_fail_assignment_insert';

  let app: INestApplication;
  let prisma: PrismaService;
  let base: string;
  let issueToken: IssueToken;

  let managerAId: string;
  let managerBId: string;
  let staffAId: string;
  let staffBId: string;
  let inactiveStaffId: string;
  let customerId: string;
  let adminId: string;

  const userIds: string[] = [];
  const orderIds: string[] = [];
  let orderCounter = 0;

  const api = async (
    method: string,
    path: string,
    options: { user?: string; body?: unknown } = {},
  ) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(options.body === undefined
          ? {}
          : { 'Content-Type': 'application/json' }),
        ...(options.user === undefined
          ? {}
          : bearerHeaders(issueToken, false)(options.user)),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    });

    const text = await res.text();

    return {
      status: res.status,
      body: text.length === 0 ? undefined : JSON.parse(text),
    };
  };

  const createUser = async (
    label: string,
    role: Role,
    status = 'ACTIVE',
  ): Promise<string> => {
    const id = randomUUID();

    await prisma.user.create({
      data: {
        id,
        firstName: 'Delivery',
        lastName: `${label}${run}`,
        email: `delivery-${run}-${label}-${id.slice(0, 8)}@example.test`,
        passwordHash: 'not-used-here',
        status,
        role,
      },
    });

    userIds.push(id);
    return id;
  };

  const createOrder = async (status = 'CONFIRMED'): Promise<string> => {
    orderCounter += 1;

    const order = await prisma.order.create({
      data: {
        userId: customerId,
        orderNumber: `DEL-${run}-${orderCounter}`,
        status,
        subtotal: '10.00',
        shippingFee: '0.00',
        discountAmount: '0.00',
        totalAmount: '10.00',
        currency: 'USD',
        shippingRecipientName: 'Delivery Test',
        shippingPhone: '+15555550100',
        shippingAddressLine1: '1 Test Street',
        shippingCity: 'Testville',
        shippingCountryCode: 'US',
      },
      select: { id: true },
    });

    orderIds.push(order.id);
    return order.id;
  };

  const createAssignment = async (
    orderId: string,
    staffId: string,
    status: DeliveryStatus = DeliveryStatus.ASSIGNED,
    options: { endedAt?: Date | null } = {},
  ) =>
    prisma.deliveryAssignment.create({
      data: {
        orderId,
        deliveryStaffId: staffId,
        assignedById: managerAId,
        status,
        endedAt: options.endedAt ?? null,
      },
    });

  const assignmentsFor = (orderId: string) =>
    prisma.deliveryAssignment.findMany({
      where: { orderId },
      orderBy: [{ assignedAt: 'asc' }, { id: 'asc' }],
    });

  const installInsertFailureTrigger = async (orderId: string) => {
    await removeInsertFailureTrigger();
    await prisma.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION "${FAILURE_TRIGGER}"() RETURNS trigger AS $fn$
       BEGIN
         RAISE EXCEPTION 'simulated delivery assignment insert failure';
       END;
       $fn$ LANGUAGE plpgsql`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER "${FAILURE_TRIGGER}"
       BEFORE INSERT ON "delivery_assignments"
       FOR EACH ROW
       WHEN (NEW."order_id" = '${orderId}'::uuid)
       EXECUTE FUNCTION "${FAILURE_TRIGGER}"()`,
    );
  };

  const removeInsertFailureTrigger = async () => {
    await prisma.$executeRawUnsafe(
      `DROP TRIGGER IF EXISTS "${FAILURE_TRIGGER}" ON "delivery_assignments"`,
    );
    await prisma.$executeRawUnsafe(
      `DROP FUNCTION IF EXISTS "${FAILURE_TRIGGER}"()`,
    );
  };

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        'DATABASE_URL is not set — the Delivery integration tests need a real PostgreSQL instance',
      );
    }

    const databaseName = new URL(process.env.DATABASE_URL).pathname;
    if (!/test/i.test(databaseName)) {
      throw new Error(
        `Refusing to run destructive Delivery fixtures against "${databaseName}"`,
      );
    }

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.listen(0);
    base = await app.getUrl();
    prisma = app.get(PrismaService);
    issueToken = tokenIssuerFor(app);

    await removeInsertFailureTrigger();

    managerAId = await createUser('manager-a', Role.DELIVERY_MANAGER);
    managerBId = await createUser('manager-b', Role.DELIVERY_MANAGER);
    staffAId = await createUser('staff-a', Role.DELIVERY_STAFF);
    staffBId = await createUser('staff-b', Role.DELIVERY_STAFF);
    inactiveStaffId = await createUser(
      'staff-inactive',
      Role.DELIVERY_STAFF,
      'SUSPENDED',
    );
    customerId = await createUser('customer', Role.CUSTOMER);
    adminId = await createUser('admin', Role.ADMIN);
  }, 120_000);

  afterAll(async () => {
    if (prisma) {
      await removeInsertFailureTrigger().catch(() => undefined);

      await prisma.deliveryAssignment.deleteMany({
        where: {
          OR: [
            { orderId: { in: orderIds } },
            { deliveryStaffId: { in: userIds } },
            { assignedById: { in: userIds } },
          ],
        },
      });
      await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }

    await app?.close();
  });

  describe('assignment', () => {
    it('assigns an eligible order to an active delivery staff member', async () => {
      const orderId = await createOrder('CONFIRMED');

      const res = await api('POST', '/delivery/manager/assign', {
        user: managerAId,
        body: { orderId, deliveryStaffId: staffAId },
      });

      expect(res.status).toBe(HttpStatus.CREATED);
      expect(res.body).toMatchObject({
        orderId,
        deliveryStaffId: staffAId,
        assignedById: managerAId,
        status: DeliveryStatus.ASSIGNED,
        endedAt: null,
      });

      const assignments = await assignmentsFor(orderId);
      expect(assignments).toHaveLength(1);
      expect(assignments[0].endedAt).toBeNull();
    });

    it('rejects an inactive delivery staff member', async () => {
      const orderId = await createOrder('CONFIRMED');

      const res = await api('POST', '/delivery/manager/assign', {
        user: managerAId,
        body: { orderId, deliveryStaffId: inactiveStaffId },
      });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(await assignmentsFor(orderId)).toHaveLength(0);
    });

    it('rejects an ineligible order', async () => {
      const orderId = await createOrder('PENDING');

      const res = await api('POST', '/delivery/manager/assign', {
        user: managerAId,
        body: { orderId, deliveryStaffId: staffAId },
      });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(await assignmentsFor(orderId)).toHaveLength(0);
    });

    it('rejects a cancelled order', async () => {
      const orderId = await createOrder('CANCELLED');

      const res = await api('POST', '/delivery/manager/assign', {
        user: managerAId,
        body: { orderId, deliveryStaffId: staffAId },
      });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(await assignmentsFor(orderId)).toHaveLength(0);
    });

    it('rejects an order that already has an active assignment', async () => {
      const orderId = await createOrder('CONFIRMED');

      const first = await api('POST', '/delivery/manager/assign', {
        user: managerAId,
        body: { orderId, deliveryStaffId: staffAId },
      });
      const second = await api('POST', '/delivery/manager/assign', {
        user: managerBId,
        body: { orderId, deliveryStaffId: staffBId },
      });

      expect(first.status).toBe(HttpStatus.CREATED);
      expect(second.status).toBe(HttpStatus.CONFLICT);

      const assignments = await assignmentsFor(orderId);
      expect(assignments).toHaveLength(1);
      expect(assignments[0].deliveryStaffId).toBe(staffAId);
      expect(assignments[0].endedAt).toBeNull();
    });

    it('preserves assignment history on reassignment', async () => {
      const orderId = await createOrder('CONFIRMED');

      const first = await api('POST', '/delivery/manager/assign', {
        user: managerAId,
        body: { orderId, deliveryStaffId: staffAId },
      });
      const second = await api(
        'POST',
        `/delivery/manager/orders/${orderId}/reassign`,
        {
          user: managerAId,
          body: { deliveryStaffId: staffBId },
        },
      );

      expect(first.status).toBe(HttpStatus.CREATED);
      expect(second.status).toBe(HttpStatus.CREATED);

      const assignments = await assignmentsFor(orderId);
      expect(assignments).toHaveLength(2);
      expect(assignments[0]).toMatchObject({
        id: first.body.id,
        deliveryStaffId: staffAId,
        status: DeliveryStatus.ASSIGNED,
      });
      expect(assignments[0].endedAt).not.toBeNull();
      expect(assignments[1]).toMatchObject({
        id: second.body.id,
        deliveryStaffId: staffBId,
        status: DeliveryStatus.ASSIGNED,
        endedAt: null,
      });
    });
  });

  describe('reassignment', () => {
    it('reassigns an eligible delivery and ends the previous assignment', async () => {
      const orderId = await createOrder('CONFIRMED');
      const previous = await createAssignment(orderId, staffAId);

      const res = await api(
        'POST',
        `/delivery/manager/orders/${orderId}/reassign`,
        {
          user: managerAId,
          body: { deliveryStaffId: staffBId },
        },
      );

      expect(res.status).toBe(HttpStatus.CREATED);

      const assignments = await assignmentsFor(orderId);
      const oldRow = assignments.find((row) => row.id === previous.id);
      const newRow = assignments.find((row) => row.id === res.body.id);

      expect(oldRow?.status).toBe(DeliveryStatus.ASSIGNED);
      expect(oldRow?.endedAt).not.toBeNull();
      expect(oldRow!.endedAt!.getTime()).toBeGreaterThanOrEqual(
        previous.assignedAt.getTime(),
      );
      expect(newRow?.deliveryStaffId).toBe(staffBId);
      expect(newRow?.endedAt).toBeNull();
    });

    it.each([
      ['OUT_FOR_DELIVERY', DeliveryStatus.OUT_FOR_DELIVERY],
      ['DELIVERED', DeliveryStatus.DELIVERED],
      ['RETURNED', DeliveryStatus.RETURNED],
    ])('rejects reassignment for %s', async (_label, status) => {
      const orderId = await createOrder('CONFIRMED');
      const previous = await createAssignment(orderId, staffAId, status);

      const res = await api(
        'POST',
        `/delivery/manager/orders/${orderId}/reassign`,
        {
          user: managerAId,
          body: { deliveryStaffId: staffBId },
        },
      );

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);

      const assignments = await assignmentsFor(orderId);
      expect(assignments).toHaveLength(1);
      expect(assignments[0].id).toBe(previous.id);
      expect(assignments[0].status).toBe(status);
      expect(assignments[0].endedAt).toBeNull();
    });
  });

  describe('lifecycle', () => {
    const validTransitions: Array<[DeliveryStatus, DeliveryStatus]> = [
      [DeliveryStatus.PENDING_ASSIGNMENT, DeliveryStatus.ASSIGNED],
      [DeliveryStatus.ASSIGNED, DeliveryStatus.OUT_FOR_DELIVERY],
      [DeliveryStatus.ASSIGNED, DeliveryStatus.FAILED_DELIVERY],
      [DeliveryStatus.ASSIGNED, DeliveryStatus.RETURNED],
      [DeliveryStatus.OUT_FOR_DELIVERY, DeliveryStatus.DELIVERED],
      [DeliveryStatus.OUT_FOR_DELIVERY, DeliveryStatus.FAILED_DELIVERY],
      [DeliveryStatus.OUT_FOR_DELIVERY, DeliveryStatus.RETURNED],
      [DeliveryStatus.FAILED_DELIVERY, DeliveryStatus.OUT_FOR_DELIVERY],
      [DeliveryStatus.FAILED_DELIVERY, DeliveryStatus.RETURNED],
    ];

    it.each(validTransitions)(
      'allows %s -> %s',
      async (from, to) => {
        const orderId = await createOrder('CONFIRMED');
        const assignment = await createAssignment(orderId, staffAId, from);

        const res = await api(
          'PATCH',
          `/delivery/staff/assignments/${assignment.id}/status`,
          { user: staffAId, body: { status: to } },
        );

        expect(res.status).toBe(HttpStatus.OK);
        expect(res.body.status).toBe(to);

        const stored = await prisma.deliveryAssignment.findUniqueOrThrow({
          where: { id: assignment.id },
        });
        expect(stored.status).toBe(to);

        if (to === DeliveryStatus.DELIVERED) {
          expect(stored.deliveredAt).not.toBeNull();
          expect(stored.endedAt).not.toBeNull();
        } else if (to === DeliveryStatus.RETURNED) {
          expect(stored.endedAt).not.toBeNull();
        } else if (to === DeliveryStatus.FAILED_DELIVERY) {
          expect(stored.endedAt).toBeNull();
        }
      },
    );

    it.each([
      [DeliveryStatus.ASSIGNED, DeliveryStatus.ASSIGNED],
      [DeliveryStatus.ASSIGNED, DeliveryStatus.DELIVERED],
      [DeliveryStatus.PENDING_ASSIGNMENT, DeliveryStatus.OUT_FOR_DELIVERY],
      [DeliveryStatus.OUT_FOR_DELIVERY, DeliveryStatus.ASSIGNED],
      [DeliveryStatus.DELIVERED, DeliveryStatus.OUT_FOR_DELIVERY],
      [DeliveryStatus.RETURNED, DeliveryStatus.ASSIGNED],
    ])('rejects %s -> %s', async (from, to) => {
      const orderId = await createOrder('CONFIRMED');
      const assignment = await createAssignment(orderId, staffAId, from);

      const res = await api(
        'PATCH',
        `/delivery/staff/assignments/${assignment.id}/status`,
        { user: staffAId, body: { status: to } },
      );

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);

      const stored = await prisma.deliveryAssignment.findUniqueOrThrow({
        where: { id: assignment.id },
      });
      expect(stored.status).toBe(from);
    });

    it('sets endedAt for DELIVERED and RETURNED, but leaves FAILED_DELIVERY active', async () => {
      const deliveredOrderId = await createOrder('CONFIRMED');
      const returnedOrderId = await createOrder('CONFIRMED');
      const failedOrderId = await createOrder('CONFIRMED');

      const delivered = await createAssignment(
        deliveredOrderId,
        staffAId,
        DeliveryStatus.OUT_FOR_DELIVERY,
      );
      const returned = await createAssignment(
        returnedOrderId,
        staffAId,
        DeliveryStatus.OUT_FOR_DELIVERY,
      );
      const failed = await createAssignment(
        failedOrderId,
        staffAId,
        DeliveryStatus.OUT_FOR_DELIVERY,
      );

      const deliver = await api(
        'PATCH',
        `/delivery/staff/assignments/${delivered.id}/status`,
        { user: staffAId, body: { status: DeliveryStatus.DELIVERED } },
      );
      const returnParcel = await api(
        'PATCH',
        `/delivery/staff/assignments/${returned.id}/status`,
        { user: staffAId, body: { status: DeliveryStatus.RETURNED } },
      );
      const fail = await api(
        'PATCH',
        `/delivery/staff/assignments/${failed.id}/status`,
        { user: staffAId, body: { status: DeliveryStatus.FAILED_DELIVERY } },
      );

      expect(deliver.status).toBe(HttpStatus.OK);
      expect(returnParcel.status).toBe(HttpStatus.OK);
      expect(fail.status).toBe(HttpStatus.OK);

      const rows = await prisma.deliveryAssignment.findMany({
        where: { id: { in: [delivered.id, returned.id, failed.id] } },
      });
      const byId = new Map(rows.map((row) => [row.id, row]));

      expect(byId.get(delivered.id)?.endedAt).not.toBeNull();
      expect(byId.get(returned.id)?.endedAt).not.toBeNull();
      expect(byId.get(failed.id)?.endedAt).toBeNull();
    });
  });

  describe('IDOR and authorisation', () => {
    it('lets staff read their own assignment', async () => {
      const orderId = await createOrder('CONFIRMED');
      const assignment = await createAssignment(orderId, staffAId);

      const res = await api(
        'GET',
        `/delivery/staff/assignments/${assignment.id}`,
        { user: staffAId },
      );

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.id).toBe(assignment.id);
    });

    it("refuses one staff member reading another's assignment", async () => {
      const orderId = await createOrder('CONFIRMED');
      const assignment = await createAssignment(orderId, staffAId);

      const res = await api(
        'GET',
        `/delivery/staff/assignments/${assignment.id}`,
        { user: staffBId },
      );

      expect(res.status).toBe(HttpStatus.FORBIDDEN);
    });

    it("refuses one staff member updating another's assignment", async () => {
      const orderId = await createOrder('CONFIRMED');
      const assignment = await createAssignment(orderId, staffAId);

      const res = await api(
        'PATCH',
        `/delivery/staff/assignments/${assignment.id}/status`,
        { user: staffBId, body: { status: DeliveryStatus.OUT_FOR_DELIVERY } },
      );

      expect(res.status).toBe(HttpStatus.FORBIDDEN);

      const stored = await prisma.deliveryAssignment.findUniqueOrThrow({
        where: { id: assignment.id },
      });
      expect(stored.status).toBe(DeliveryStatus.ASSIGNED);
    });

    it.each([
      ['customer', () => customerId],
      ['delivery staff', () => staffAId],
    ])('refuses %s access to manager endpoints', async (_label, id) => {
      const orderId = await createOrder('CONFIRMED');

      const list = await api('GET', '/delivery/manager/orders', {
        user: id(),
      });
      const assign = await api('POST', '/delivery/manager/assign', {
        user: id(),
        body: { orderId, deliveryStaffId: staffAId },
      });

      expect(list.status).toBe(HttpStatus.FORBIDDEN);
      expect(assign.status).toBe(HttpStatus.FORBIDDEN);
      expect(await assignmentsFor(orderId)).toHaveLength(0);
    });

    /**
     * Current policy in this working tree: `DELIVERY_MANAGER_ROLES` includes
     * ADMIN. The task explicitly asked not to grant ADMIN automatically, so this
     * test records the existing behavior rather than changing it; the final
     * report calls out that the policy needs an explicit decision.
     */
    it('allows ADMIN on manager endpoints under the current role policy', async () => {
      const orderId = await createOrder('CONFIRMED');

      const list = await api('GET', '/delivery/manager/orders', {
        user: adminId,
      });
      const assign = await api('POST', '/delivery/manager/assign', {
        user: adminId,
        body: { orderId, deliveryStaffId: staffAId },
      });

      expect(list.status).toBe(HttpStatus.OK);
      expect(assign.status).toBe(HttpStatus.CREATED);
      expect(await assignmentsFor(orderId)).toHaveLength(1);
    });

    it.each([
      ['manager', () => managerAId],
      ['customer', () => customerId],
      ['admin', () => adminId],
    ])('refuses %s access to staff endpoints', async (_label, id) => {
      const list = await api('GET', '/delivery/staff/assignments', {
        user: id(),
      });

      expect(list.status).toBe(HttpStatus.FORBIDDEN);
    });

    it('refuses unauthenticated callers', async () => {
      const list = await api('GET', '/delivery/staff/assignments');

      expect(list.status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it('refuses an inactive delivery staff token at authentication', async () => {
      const res = await api('GET', '/delivery/staff/assignments', {
        user: inactiveStaffId,
      });

      expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
    });
  });

  describe('concurrency', () => {
    it('creates exactly one active assignment when two managers race', async () => {
      const orderId = await createOrder('CONFIRMED');

      const [first, second] = await Promise.all([
        api('POST', '/delivery/manager/assign', {
          user: managerAId,
          body: { orderId, deliveryStaffId: staffAId },
        }),
        api('POST', '/delivery/manager/assign', {
          user: managerBId,
          body: { orderId, deliveryStaffId: staffBId },
        }),
      ]);

      expect([first.status, second.status].sort()).toEqual([
        HttpStatus.CREATED,
        HttpStatus.CONFLICT,
      ]);

      const assignments = await assignmentsFor(orderId);
      expect(assignments).toHaveLength(1);
      expect(assignments[0].endedAt).toBeNull();
    });

    it('keeps the partial unique index as the final duplicate-active guard', async () => {
      const orderId = await createOrder('CONFIRMED');
      await createAssignment(orderId, staffAId);

      let error: { code?: string } | undefined;

      try {
        await createAssignment(orderId, staffBId);
      } catch (caught) {
        error = caught as { code?: string };
      }

      expect(['P2002', '23505']).toContain(error?.code);
      expect(await assignmentsFor(orderId)).toHaveLength(1);
    });
  });

  describe('transaction and rollback', () => {
    it('leaves no assignment when the insert fails during assignment', async () => {
      const orderId = await createOrder('CONFIRMED');

      try {
        await installInsertFailureTrigger(orderId);

        const res = await api('POST', '/delivery/manager/assign', {
          user: managerAId,
          body: { orderId, deliveryStaffId: staffAId },
        });

        expect(res.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      } finally {
        await removeInsertFailureTrigger();
      }

      expect(await assignmentsFor(orderId)).toHaveLength(0);
    });

    it('rolls back the previous endedAt when reassignment insert fails', async () => {
      const orderId = await createOrder('CONFIRMED');
      const previous = await createAssignment(orderId, staffAId);

      try {
        await installInsertFailureTrigger(orderId);

        const res = await api(
          'POST',
          `/delivery/manager/orders/${orderId}/reassign`,
          {
            user: managerAId,
            body: { deliveryStaffId: staffBId },
          },
        );

        expect(res.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      } finally {
        await removeInsertFailureTrigger();
      }

      const assignments = await assignmentsFor(orderId);
      expect(assignments).toHaveLength(1);
      expect(assignments[0].id).toBe(previous.id);
      expect(assignments[0].status).toBe(DeliveryStatus.ASSIGNED);
      expect(assignments[0].endedAt).toBeNull();
    });
  });
});
