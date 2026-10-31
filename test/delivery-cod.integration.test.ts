import 'dotenv/config';
import {
  HttpStatus,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module.js';
import { DeliveryStatus, Role } from '../src/generated/prisma/enums.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import {
  bearerHeaders,
  tokenIssuerFor,
  type IssueToken,
} from './support/e2e-auth.js';

/**
 * COD collection against a **real PostgreSQL** database.
 *
 * This suite proves the parts only the database can:
 *
 * - a collection is written exactly once per order, even when two requests race;
 * - an existing `Payment` row is settled in the same transaction as the
 *   collection, and a failed insert rolls that payment update back;
 * - ownership, assignment state, staff status, payment method, amount and
 *   currency are all enforced through the real HTTP guards and DTO pipeline.
 *
 * Fixtures are namespaced by a per-run token and removed in `afterAll`. The
 * dedicated Vitest config points `DATABASE_URL` at an isolated `*_test`
 * database, so cleanup can never reach development data.
 */
describe('COD collection (PostgreSQL)', () => {
  const run = randomUUID().slice(0, 8);
  const FAILURE_TRIGGER = 'delivery_cod_test_fail_collection_insert';

  let app: INestApplication;
  let prisma: PrismaService;
  let base: string;
  let issueToken: IssueToken;

  let managerId: string;
  let staffAId: string;
  let staffBId: string;
  let inactiveStaffId: string;
  let customerId: string;
  let shippingProviderId: string;
  let codAreaId: string;

  const userIds: string[] = [];
  const orderIds: string[] = [];
  let orderCounter = 0;
  let paymentCounter = 0;

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
        firstName: 'COD',
        lastName: `${label}${run}`,
        email: `cod-${run}-${label}-${id.slice(0, 8)}@example.test`,
        passwordHash: 'not-used-here',
        status,
        role,
      },
    });

    userIds.push(id);
    return id;
  };

  const createOrder = async (
    options: {
      status?: string;
      paymentMethod?: string | null;
      totalAmount?: string;
      currency?: string;
    } = {},
  ): Promise<string> => {
    orderCounter += 1;
    const totalAmount = options.totalAmount ?? '10.00';

    const order = await prisma.order.create({
      data: {
        userId: customerId,
        orderNumber: `COD-${run}-${orderCounter}`,
        status: options.status ?? 'CONFIRMED',
        subtotal: totalAmount,
        shippingFee: '0.00',
        discountAmount: '0.00',
        totalAmount,
        currency: options.currency ?? 'USD',
        paymentMethod: options.paymentMethod ?? 'COD',
        shippingProviderId,
        shippingProviderCode: `COD-${run}`,
        shippingProviderName: `COD Test ${run}`,
        codAreaId:
          (options.paymentMethod ?? 'COD') === 'COD' ? codAreaId : null,
        codAreaCode:
          (options.paymentMethod ?? 'COD') === 'COD' ? `COD-${run}` : null,
        codAreaName:
          (options.paymentMethod ?? 'COD') === 'COD'
            ? `COD Area ${run}`
            : null,
        shippingRecipientName: 'COD Test',
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
    options: {
      status?: DeliveryStatus;
      endedAt?: Date | null;
    } = {},
  ) =>
    prisma.deliveryAssignment.create({
      data: {
        orderId,
        deliveryStaffId: staffId,
        assignedById: managerId,
        status: options.status ?? DeliveryStatus.ASSIGNED,
        endedAt: options.endedAt ?? null,
      },
    });

  const createPayment = async (
    orderId: string,
    status = 'PENDING',
  ) => {
    paymentCounter += 1;

    return prisma.payment.create({
      data: {
        orderId,
        provider: 'ABA_PAYWAY',
        transactionId: `cod-${run}-${paymentCounter}`,
        status,
        amount: '10.00',
        currency: 'USD',
      },
    });
  };

  const installCollectionFailureTrigger = async (orderId: string) => {
    await removeCollectionFailureTrigger();
    await prisma.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION "${FAILURE_TRIGGER}"() RETURNS trigger AS $fn$
       BEGIN
         RAISE EXCEPTION 'simulated COD collection insert failure';
       END;
       $fn$ LANGUAGE plpgsql`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER "${FAILURE_TRIGGER}"
       BEFORE INSERT ON "cod_collections"
       FOR EACH ROW
       WHEN (NEW."order_id" = '${orderId}'::uuid)
       EXECUTE FUNCTION "${FAILURE_TRIGGER}"()`,
    );
  };

  const removeCollectionFailureTrigger = async () => {
    await prisma.$executeRawUnsafe(
      `DROP TRIGGER IF EXISTS "${FAILURE_TRIGGER}" ON "cod_collections"`,
    );
    await prisma.$executeRawUnsafe(
      `DROP FUNCTION IF EXISTS "${FAILURE_TRIGGER}"()`,
    );
  };

  const collect = (
    assignmentId: string,
    user: string,
    body: Record<string, unknown>,
  ) =>
    api('POST', `/delivery/staff/assignments/${assignmentId}/collect-cod`, {
      user,
      body,
    });

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        'DATABASE_URL is not set — the COD integration tests need a real PostgreSQL instance',
      );
    }

    const databaseName = new URL(process.env.DATABASE_URL).pathname;
    if (!/test/i.test(databaseName)) {
      throw new Error(
        `Refusing to run destructive COD fixtures against "${databaseName}"`,
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

    await removeCollectionFailureTrigger();

    managerId = await createUser('manager', Role.DELIVERY_MANAGER);
    staffAId = await createUser('staff-a', Role.DELIVERY_STAFF);
    staffBId = await createUser('staff-b', Role.DELIVERY_STAFF);
    inactiveStaffId = await createUser(
      'staff-inactive',
      Role.DELIVERY_STAFF,
      'SUSPENDED',
    );
    customerId = await createUser('customer', Role.CUSTOMER);

    const upperRun = run.toUpperCase();

    const provider = await prisma.shippingProvider.create({
      data: {
        code: `COD-${upperRun}`,
        name: `COD Test ${run}`,
        baseFee: '0.00',
        supportsCod: true,
        isActive: true,
      },
      select: { id: true },
    });
    shippingProviderId = provider.id;

    const codArea = await prisma.codArea.create({
      data: {
        code: `COD-${upperRun}`,
        name: `COD Area ${run}`,
        codEnabled: true,
      },
      select: { id: true },
    });
    codAreaId = codArea.id;
  }, 120_000);

  afterAll(async () => {
    if (prisma) {
      await removeCollectionFailureTrigger().catch(() => undefined);

      await prisma.codCollection.deleteMany({
        where: {
          OR: [
            { orderId: { in: orderIds } },
            { collectedById: { in: userIds } },
          ],
        },
      });
      await prisma.payment.deleteMany({
        where: { orderId: { in: orderIds } },
      });
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

  describe('successful collection', () => {
    it('records a COD collection for the assigned active staff member', async () => {
      const orderId = await createOrder();
      const assignment = await createAssignment(orderId, staffAId);

      const res = await collect(assignment.id, staffAId, {
        amount: '10.00',
        currency: 'USD',
        notes: 'Cash received',
      });

      expect(res.status).toBe(HttpStatus.CREATED);
      expect(res.body).toMatchObject({
        orderId,
        paymentId: null,
        collectedById: staffAId,
        currency: 'USD',
        notes: 'Cash received',
      });

      const stored = await prisma.codCollection.findUniqueOrThrow({
        where: { orderId },
      });
      expect(stored.amount.toFixed(2)).toBe('10.00');
      expect(stored.receiptProof).toBeNull();
    });

    it('links and settles an existing payment in the same transaction', async () => {
      const orderId = await createOrder();
      const assignment = await createAssignment(orderId, staffAId);
      const payment = await createPayment(orderId);

      const res = await collect(assignment.id, staffAId, {
        amount: '10.00',
        currency: 'USD',
      });

      expect(res.status).toBe(HttpStatus.CREATED);
      expect(res.body.paymentId).toBe(payment.id);

      const settled = await prisma.payment.findUniqueOrThrow({
        where: { id: payment.id },
      });
      expect(settled.status).toBe('PAID');
      expect(settled.paymentMethod).toBe('COD');
      expect(settled.paidAt).not.toBeNull();
    });
  });

  describe('validation', () => {
    it('rejects an amount that does not equal the order total', async () => {
      const orderId = await createOrder();
      const assignment = await createAssignment(orderId, staffAId);

      const res = await collect(assignment.id, staffAId, {
        amount: '9.99',
        currency: 'USD',
      });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(
        await prisma.codCollection.count({ where: { orderId } }),
      ).toBe(0);
    });

    it('rejects a currency that does not match the order currency', async () => {
      const orderId = await createOrder();
      const assignment = await createAssignment(orderId, staffAId);

      const res = await collect(assignment.id, staffAId, {
        amount: '10.00',
        currency: 'EUR',
      });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(
        await prisma.codCollection.count({ where: { orderId } }),
      ).toBe(0);
    });

    it('rejects a non-COD order', async () => {
      const orderId = await createOrder({ paymentMethod: 'ABA_PAYWAY' });
      const assignment = await createAssignment(orderId, staffAId);

      const res = await collect(assignment.id, staffAId, {
        amount: '10.00',
        currency: 'USD',
      });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(
        await prisma.codCollection.count({ where: { orderId } }),
      ).toBe(0);
    });

    it('rejects a client-supplied receipt URL instead of storing it', async () => {
      const orderId = await createOrder();
      const assignment = await createAssignment(orderId, staffAId);

      const res = await collect(assignment.id, staffAId, {
        amount: '10.00',
        currency: 'USD',
        receiptProof: 'https://attacker.example/receipt.png',
      });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(
        await prisma.codCollection.count({ where: { orderId } }),
      ).toBe(0);
    });
  });

  describe('authorisation', () => {
    it('refuses another delivery staff member', async () => {
      const orderId = await createOrder();
      const assignment = await createAssignment(orderId, staffAId);

      const res = await collect(assignment.id, staffBId, {
        amount: '10.00',
        currency: 'USD',
      });

      expect(res.status).toBe(HttpStatus.FORBIDDEN);
      expect(
        await prisma.codCollection.count({ where: { orderId } }),
      ).toBe(0);
    });

    it('refuses an inactive assignment', async () => {
      const orderId = await createOrder();
      const assignment = await createAssignment(orderId, staffAId, {
        endedAt: new Date(),
      });

      const res = await collect(assignment.id, staffAId, {
        amount: '10.00',
        currency: 'USD',
      });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(
        await prisma.codCollection.count({ where: { orderId } }),
      ).toBe(0);
    });

    it('refuses a terminal assignment even if endedAt was not set', async () => {
      const orderId = await createOrder();
      const assignment = await createAssignment(orderId, staffAId, {
        status: DeliveryStatus.DELIVERED,
      });

      const res = await collect(assignment.id, staffAId, {
        amount: '10.00',
        currency: 'USD',
      });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(
        await prisma.codCollection.count({ where: { orderId } }),
      ).toBe(0);
    });

    it('refuses an inactive delivery staff member at authentication', async () => {
      const orderId = await createOrder();
      const assignment = await createAssignment(orderId, staffAId);

      const res = await collect(assignment.id, inactiveStaffId, {
        amount: '10.00',
        currency: 'USD',
      });

      expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
      expect(
        await prisma.codCollection.count({ where: { orderId } }),
      ).toBe(0);
    });
  });

  describe('duplicate and concurrency', () => {
    it('rejects a second collection for the same order', async () => {
      const orderId = await createOrder();
      const assignment = await createAssignment(orderId, staffAId);

      const first = await collect(assignment.id, staffAId, {
        amount: '10.00',
        currency: 'USD',
      });
      const second = await collect(assignment.id, staffAId, {
        amount: '10.00',
        currency: 'USD',
      });

      expect(first.status).toBe(HttpStatus.CREATED);
      expect(second.status).toBe(HttpStatus.CONFLICT);
      expect(
        await prisma.codCollection.count({ where: { orderId } }),
      ).toBe(1);
    });

    it('creates exactly one collection when two requests race', async () => {
      const orderId = await createOrder();
      const assignment = await createAssignment(orderId, staffAId);

      const [first, second] = await Promise.all([
        collect(assignment.id, staffAId, {
          amount: '10.00',
          currency: 'USD',
        }),
        collect(assignment.id, staffAId, {
          amount: '10.00',
          currency: 'USD',
        }),
      ]);

      expect([first.status, second.status].sort()).toEqual([
        HttpStatus.CREATED,
        HttpStatus.CONFLICT,
      ]);
      expect(
        await prisma.codCollection.count({ where: { orderId } }),
      ).toBe(1);
    });
  });

  describe('transaction rollback', () => {
    it('rolls back the payment update when the collection insert fails', async () => {
      const orderId = await createOrder();
      const assignment = await createAssignment(orderId, staffAId);
      const payment = await createPayment(orderId);

      try {
        await installCollectionFailureTrigger(orderId);

        const res = await collect(assignment.id, staffAId, {
          amount: '10.00',
          currency: 'USD',
        });

        expect(res.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      } finally {
        await removeCollectionFailureTrigger();
      }

      expect(
        await prisma.codCollection.count({ where: { orderId } }),
      ).toBe(0);

      const unchanged = await prisma.payment.findUniqueOrThrow({
        where: { id: payment.id },
      });
      expect(unchanged.status).toBe('PENDING');
      expect(unchanged.paidAt).toBeNull();
      expect(unchanged.paymentMethod).toBeNull();
    });
  });
});
