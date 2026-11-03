import 'dotenv/config';
import {
  HttpStatus,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { DeliveryStatus, Role } from '../src/generated/prisma/enums.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { DeliveryRepository } from '../src/delivery/repositories/delivery.repository.js';
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
  const DELIVERY_FAILURE_TRIGGER = 'delivery_cod_test_fail_delivery_update';

  let app: INestApplication;
  let prisma: PrismaService;
  let base: string;
  let issueToken: IssueToken;
  let deliveryRepository: DeliveryRepository;

  let managerId: string;
  let staffAId: string;
  let staffBId: string;
  let inactiveStaffId: string;
  let adminId: string;
  let customerId: string;
  let shippingProviderId: string;
  let codAreaId: string;
  let checkoutVariantId: string;
  let checkoutAddressId: string;
  let checkoutCartId: string;
  let checkoutCategoryId: string;
  let checkoutProductId: string;
  let previousLocationCodOverride: boolean | null = null;
  let locationCodOverrideCaptured = false;

  const userIds: string[] = [];
  const orderIds: string[] = [];
  const quoteIds: string[] = [];
  const reconciliationRunIds: string[] = [];
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

  const installDeliveryFailureTrigger = async (
    table: 'orders' | 'delivery_assignments',
    rowId: string,
  ) => {
    await removeDeliveryFailureTrigger();
    await prisma.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION "${DELIVERY_FAILURE_TRIGGER}"() RETURNS trigger AS $fn$
       BEGIN
         RAISE EXCEPTION 'simulated delivery lifecycle update failure';
       END;
       $fn$ LANGUAGE plpgsql`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER "${DELIVERY_FAILURE_TRIGGER}"
       BEFORE UPDATE ON "${table}"
       FOR EACH ROW
       WHEN (NEW."id" = '${rowId}'::uuid)
       EXECUTE FUNCTION "${DELIVERY_FAILURE_TRIGGER}"()`,
    );
  };

  const removeDeliveryFailureTrigger = async () => {
    await prisma.$executeRawUnsafe(
      `DROP TRIGGER IF EXISTS "${DELIVERY_FAILURE_TRIGGER}" ON "orders"`,
    );
    await prisma.$executeRawUnsafe(
      `DROP TRIGGER IF EXISTS "${DELIVERY_FAILURE_TRIGGER}" ON "delivery_assignments"`,
    );
    await prisma.$executeRawUnsafe(
      `DROP FUNCTION IF EXISTS "${DELIVERY_FAILURE_TRIGGER}"()`,
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

  const updateAssignmentStatus = (
    assignmentId: string,
    user: string,
    status: DeliveryStatus,
  ) =>
    api(
      'PATCH',
      `/delivery/staff/assignments/${assignmentId}/status`,
      { user, body: { status } },
    );

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
    deliveryRepository = app.get(DeliveryRepository);
    issueToken = tokenIssuerFor(app);

    await removeCollectionFailureTrigger();
    await removeDeliveryFailureTrigger();

    managerId = await createUser('manager', Role.DELIVERY_MANAGER);
    staffAId = await createUser('staff-a', Role.DELIVERY_STAFF);
    staffBId = await createUser('staff-b', Role.DELIVERY_STAFF);
    adminId = await createUser('admin', Role.ADMIN);
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

    const category = await prisma.category.create({
      data: {
        name: `COD Lifecycle ${run}`,
        slug: `cod-lifecycle-${run}`,
      },
      select: { id: true },
    });
    checkoutCategoryId = category.id;
    const product = await prisma.product.create({
      data: {
        categoryId: checkoutCategoryId,
        name: `COD Lifecycle Product ${run}`,
        slug: `cod-lifecycle-product-${run}`,
        basePrice: '12.34',
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    checkoutProductId = product.id;
    const variant = await prisma.productVariant.create({
      data: {
        productId: checkoutProductId,
        sku: `COD-LIFECYCLE-${run}`,
        price: '12.34',
      },
      select: { id: true },
    });
    checkoutVariantId = variant.id;
    await prisma.inventory.create({
      data: {
        variantId: checkoutVariantId,
        quantity: 8,
        reservedQuantity: 0,
      },
    });
    const address = await prisma.address.create({
      data: {
        userId: customerId,
        label: 'COD lifecycle',
        recipientName: 'COD Lifecycle Customer',
        phone: '+85512345678',
        addressLine1: '12 Integration Test Street',
        city: 'Doun Penh',
        stateProvince: 'Phnom Penh',
        countryCode: 'KH',
        administrativeLocationPcode: 'KH12',
      },
      select: { id: true },
    });
    checkoutAddressId = address.id;
    const cart = await prisma.cart.create({
      data: { userId: customerId },
      select: { id: true },
    });
    checkoutCartId = cart.id;

    const province = await prisma.administrativeLocation.findUniqueOrThrow({
      where: { pcode: 'KH12' },
      select: { codEnabledOverride: true },
    });
    previousLocationCodOverride = province.codEnabledOverride;
    locationCodOverrideCaptured = true;
    await prisma.administrativeLocation.update({
      where: { pcode: 'KH12' },
      data: { codEnabledOverride: true },
    });
  }, 120_000);

  afterAll(async () => {
    if (prisma) {
      await removeCollectionFailureTrigger().catch(() => undefined);
      await removeDeliveryFailureTrigger().catch(() => undefined);

      if (locationCodOverrideCaptured) {
        await prisma.administrativeLocation.update({
          where: { pcode: 'KH12' },
          data: { codEnabledOverride: previousLocationCodOverride },
        });
      }
      await prisma.codReconciliationRunItem.deleteMany({
        where: { runId: { in: reconciliationRunIds } },
      });
      await prisma.codReconciliationRun.deleteMany({
        where: { id: { in: reconciliationRunIds } },
      });
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
      await prisma.checkoutQuote.deleteMany({
        where: {
          OR: [
            { id: { in: quoteIds } },
            { orderId: { in: orderIds } },
          ],
        },
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
      await prisma.orderItem.deleteMany({
        where: { orderId: { in: orderIds } },
      });
      await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
      await prisma.cartItem.deleteMany({ where: { cartId: checkoutCartId } });
      await prisma.cart.deleteMany({ where: { id: checkoutCartId } });
      await prisma.address.deleteMany({ where: { id: checkoutAddressId } });
      await prisma.inventory.deleteMany({
        where: { variantId: checkoutVariantId },
      });
      await prisma.productVariant.deleteMany({
        where: { id: checkoutVariantId },
      });
      await prisma.product.deleteMany({
        where: { id: checkoutProductId },
      });
      await prisma.category.deleteMany({
        where: { id: checkoutCategoryId },
      });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }

    await app?.close();
  });

  describe('delivery completion and COD collection', () => {
    const createCheckoutCodOrder = async () => {
      await prisma.inventory.update({
        where: { variantId: checkoutVariantId },
        data: { quantity: 8, reservedQuantity: 0 },
      });
      await prisma.cartItem.deleteMany({ where: { cartId: checkoutCartId } });
      await prisma.cartItem.create({
        data: {
          cartId: checkoutCartId,
          variantId: checkoutVariantId,
          quantity: 2,
        },
      });

      const quote = await api('POST', '/checkout/quote', {
        user: customerId,
        body: {
          addressId: checkoutAddressId,
          shippingProviderId,
          paymentMethod: 'COD',
        },
      });
      expect(quote.status).toBe(HttpStatus.CREATED);
      quoteIds.push(quote.body.quoteId);

      const checkout = await api('POST', '/checkout', {
        user: customerId,
        body: {
          quoteId: quote.body.quoteId,
          idempotencyKey: randomUUID(),
        },
      });
      expect(checkout.status, JSON.stringify(checkout.body)).toBe(
        HttpStatus.CREATED,
      );
      orderIds.push(checkout.body.id);
      return checkout.body.id as string;
    };

    const confirmAssignAndShip = async (orderId: string) => {
      const confirmed = await api(
        'POST',
        `/admin/orders/${orderId}/confirm-cod`,
        { user: adminId },
      );
      expect(confirmed.status).toBe(HttpStatus.OK);
      expect(confirmed.body.status).toBe('CONFIRMED');

      const assigned = await api('POST', '/delivery/manager/assign', {
        user: adminId,
        body: { orderId, deliveryStaffId: staffAId },
      });
      expect(assigned.status).toBe(HttpStatus.CREATED);
      expect(assigned.body.deliveryStaffId).toBe(staffAId);

      const persistedAssignment =
        await prisma.deliveryAssignment.findUniqueOrThrow({
          where: { id: assigned.body.id },
        });
      expect(persistedAssignment.orderId).toBe(orderId);
      expect(persistedAssignment.deliveryStaffId).toBe(staffAId);

      const shipped = await api('POST', `/admin/orders/${orderId}/ship`, {
        user: adminId,
      });
      expect(shipped.status).toBe(HttpStatus.OK);
      expect(shipped.body.status).toBe('SHIPPED');

      return persistedAssignment;
    };

    const deliverAssignedOrder = async (assignmentId: string) => {
      const outForDelivery = await updateAssignmentStatus(
        assignmentId,
        staffAId,
        DeliveryStatus.OUT_FOR_DELIVERY,
      );
      expect(outForDelivery.status).toBe(HttpStatus.OK);

      const delivered = await updateAssignmentStatus(
        assignmentId,
        staffAId,
        DeliveryStatus.DELIVERED,
      );
      expect(delivered.status).toBe(HttpStatus.OK);
      expect(delivered.body.status).toBe(DeliveryStatus.DELIVERED);
      expect(delivered.body.order.status).toBe('DELIVERED');

      const assignment = await prisma.deliveryAssignment.findUniqueOrThrow({
        where: { id: assignmentId },
      });
      expect(assignment.status).toBe(DeliveryStatus.DELIVERED);
      expect(assignment.deliveredAt).toBeInstanceOf(Date);
      expect(assignment.deliveredAt!.getTime()).toBeGreaterThan(0);
      return assignment;
    };

    const triggerReconciliation = async (
      windowStart: Date,
      windowEnd: Date,
    ) => {
      const response = await api(
        'POST',
        '/admin/cod-reconciliation/runs/trigger',
        {
          user: adminId,
          body: {
            windowStart: windowStart.toISOString(),
            windowEnd: windowEnd.toISOString(),
          },
        },
      );
      expect(response.status).toBe(HttpStatus.CREATED);
      reconciliationRunIds.push(response.body.run.id);
      return response.body.run;
    };

    it('completes COD checkout, assignment, delivery, collection, and half-open reconciliation', async () => {
      const orderId = await createCheckoutCodOrder();
      const pendingOrder = await prisma.order.findUniqueOrThrow({
        where: { id: orderId },
      });
      expect(pendingOrder.status).toBe('PENDING');
      expect(pendingOrder.paymentMethod).toBe('COD');
      expect(pendingOrder.totalAmount).toBeInstanceOf(Prisma.Decimal);
      expect(pendingOrder.totalAmount.toFixed(2)).toBe('24.68');
      expect(await prisma.payment.count({ where: { orderId } })).toBe(0);
      expect(
        await prisma.inventory.findUniqueOrThrow({
          where: { variantId: checkoutVariantId },
        }),
      ).toMatchObject({ quantity: 8, reservedQuantity: 2 });

      const assignment = await confirmAssignAndShip(orderId);
      const shippedStock = await prisma.inventory.findUniqueOrThrow({
        where: { variantId: checkoutVariantId },
      });
      expect(shippedStock).toMatchObject({ quantity: 6, reservedQuantity: 0 });

      const duplicateShip = await api(
        'POST',
        `/admin/orders/${orderId}/ship`,
        { user: adminId },
      );
      expect(duplicateShip.status).toBe(HttpStatus.CONFLICT);
      expect(
        await prisma.inventory.findUniqueOrThrow({
          where: { variantId: checkoutVariantId },
        }),
      ).toMatchObject({ quantity: 6, reservedQuantity: 0 });

      const deliveredAssignment = await deliverAssignedOrder(assignment.id);
      const deliveredAt = deliveredAssignment.deliveredAt!;
      expect(
        (await prisma.order.findUniqueOrThrow({ where: { id: orderId } }))
          .status,
      ).toBe('DELIVERED');
      expect(
        await prisma.inventory.findUniqueOrThrow({
          where: { variantId: checkoutVariantId },
        }),
      ).toMatchObject({ quantity: 6, reservedQuantity: 0 });

      const collectionResponse = await collect(assignment.id, staffAId, {
        amount: '24.68',
        currency: 'USD',
      });
      expect(collectionResponse.status).toBe(HttpStatus.CREATED);
      expect(collectionResponse.body).toMatchObject({
        orderId,
        paymentId: null,
        collectedById: staffAId,
        amount: '24.68',
        currency: 'USD',
      });
      const collection = await prisma.codCollection.findUniqueOrThrow({
        where: { orderId },
      });
      expect(collection.amount).toBeInstanceOf(Prisma.Decimal);
      expect(collection.amount.toFixed(2)).toBe('24.68');
      expect(collection.currency).toBe('USD');
      expect(await prisma.payment.count({ where: { orderId } })).toBe(0);
      expect(
        await prisma.inventory.findUniqueOrThrow({
          where: { variantId: checkoutVariantId },
        }),
      ).toMatchObject({ quantity: 6, reservedQuantity: 0 });

      const windowStart = deliveredAt;
      const windowEnd = new Date(windowStart.getTime() + 1);
      const nextWindowEnd = new Date(windowEnd.getTime() + 60_000);
      const uncollectedOrderId = await createCheckoutCodOrder();
      const uncollectedAssignment = await confirmAssignAndShip(
        uncollectedOrderId,
      );
      const uncollectedDelivered = await deliverAssignedOrder(
        uncollectedAssignment.id,
      );
      await prisma.deliveryAssignment.update({
        where: { id: uncollectedAssignment.id },
        data: { deliveredAt: windowEnd },
      });
      expect(uncollectedDelivered.deliveredAt).toBeInstanceOf(Date);

      const boundaryQuery = await deliveryRepository.findCodReconciliationRecords(
        {
          startDate: windowStart,
          endDateExclusive: windowEnd,
          limit: 100,
        },
      );
      expect(boundaryQuery.items.map((item) => item.orderId)).toEqual([
        orderId,
      ]);

      const firstRun = await triggerReconciliation(windowStart, windowEnd);
      expect(firstRun).toMatchObject({
        status: 'completed',
        processedCount: 1,
        matchedCount: 1,
        discrepancyCount: 0,
        uncollectedCount: 0,
      });
      const firstRunRead = await api(
        'GET',
        `/admin/cod-reconciliation/runs/${firstRun.id}`,
        { user: adminId },
      );
      expect(firstRunRead.status).toBe(HttpStatus.OK);
      expect(firstRunRead.body).toMatchObject({
        id: firstRun.id,
        processedCount: 1,
        matchedCount: 1,
        discrepancyCount: 0,
      });
      const matchedRecords =
        await deliveryRepository.findCodReconciliationRecords({
          orderId,
          startDate: windowStart,
          endDateExclusive: windowEnd,
        });
      expect(matchedRecords.total).toBe(1);
      expect(matchedRecords.items[0]).toMatchObject({
        orderId,
        orderStatus: 'DELIVERED',
        currency: 'USD',
        discrepancy: false,
        discrepancyType: null,
        collectedAmount: new Prisma.Decimal('24.68'),
      });
      expect(matchedRecords.items[0].expectedAmount).toBeInstanceOf(
        Prisma.Decimal,
      );
      expect(matchedRecords.items[0].expectedAmount.toFixed(2)).toBe('24.68');

      const secondRun = await triggerReconciliation(windowEnd, nextWindowEnd);
      expect(secondRun).toMatchObject({
        status: 'completed',
        processedCount: 1,
        matchedCount: 0,
        discrepancyCount: 1,
        uncollectedCount: 1,
      });
      const uncollectedRecords =
        await deliveryRepository.findCodReconciliationRecords({
          orderId: uncollectedOrderId,
        });
      expect(uncollectedRecords.items[0]).toMatchObject({
        orderId: uncollectedOrderId,
        orderStatus: 'DELIVERED',
        discrepancy: true,
        discrepancyType: 'missing-collection',
        currency: 'USD',
      });
      expect(uncollectedRecords.items[0].expectedAmount).toBeInstanceOf(
        Prisma.Decimal,
      );
      expect(uncollectedRecords.items[0].expectedAmount.toFixed(2)).toBe(
        '24.68',
      );
    });

    it('classifies a delivered COD order without collection as uncollected', async () => {
      const orderId = await createCheckoutCodOrder();
      const pendingOrder = await prisma.order.findUniqueOrThrow({
        where: { id: orderId },
      });
      expect(pendingOrder.status).toBe('PENDING');
      expect(pendingOrder.paymentMethod).toBe('COD');
      expect(await prisma.payment.count({ where: { orderId } })).toBe(0);
      expect(
        await prisma.inventory.findUniqueOrThrow({
          where: { variantId: checkoutVariantId },
        }),
      ).toMatchObject({ quantity: 8, reservedQuantity: 2 });

      const assignment = await confirmAssignAndShip(orderId);
      const shippedStock = await prisma.inventory.findUniqueOrThrow({
        where: { variantId: checkoutVariantId },
      });
      expect(shippedStock).toMatchObject({ quantity: 6, reservedQuantity: 0 });
      const deliveredAssignment = await deliverAssignedOrder(assignment.id);
      const deliveredAt = deliveredAssignment.deliveredAt!;
      expect(
        await prisma.codCollection.count({ where: { orderId } }),
      ).toBe(0);
      expect(await prisma.payment.count({ where: { orderId } })).toBe(0);

      const windowEnd = new Date(deliveredAt.getTime() + 60_000);
      const run = await triggerReconciliation(deliveredAt, windowEnd);
      expect(run).toMatchObject({
        status: 'completed',
        processedCount: 1,
        matchedCount: 0,
        discrepancyCount: 1,
        uncollectedCount: 1,
      });
      const records = await deliveryRepository.findCodReconciliationRecords({
        orderId,
      });
      expect(records.items[0]).toMatchObject({
        orderId,
        discrepancy: true,
        discrepancyType: 'missing-collection',
      });
    });

    const createShippedDelivery = async (staffId = staffAId) => {
      const orderId = await createOrder({ status: 'SHIPPED' });
      const assignment = await createAssignment(
        orderId,
        staffId,
        { status: DeliveryStatus.OUT_FOR_DELIVERY },
      );
      return { orderId, assignment };
    };

    it('atomically delivers the order, records authoritative deliveredAt, collects COD, and reconciles it', async () => {
      const { orderId, assignment } = await createShippedDelivery();

      const delivered = await updateAssignmentStatus(
        assignment.id,
        staffAId,
        DeliveryStatus.DELIVERED,
      );

      expect(delivered.status).toBe(HttpStatus.OK);
      expect(delivered.body.status).toBe(DeliveryStatus.DELIVERED);
      expect(delivered.body.order.status).toBe('DELIVERED');

      const persistedOrder = await prisma.order.findUniqueOrThrow({
        where: { id: orderId },
      });
      const persistedAssignment =
        await prisma.deliveryAssignment.findUniqueOrThrow({
          where: { id: assignment.id },
        });
      expect(persistedOrder.status).toBe('DELIVERED');
      expect(persistedAssignment.status).toBe(DeliveryStatus.DELIVERED);
      expect(persistedAssignment.deliveredAt).toBeInstanceOf(Date);
      expect(persistedAssignment.deliveredAt?.getTime()).toBeGreaterThan(0);

      const collection = await collect(assignment.id, staffAId, {
        amount: '10.00',
        currency: 'USD',
      });
      expect(collection.status).toBe(HttpStatus.CREATED);
      expect(collection.body).toMatchObject({
        orderId,
        paymentId: null,
        collectedById: staffAId,
      });
      expect(await prisma.payment.count({ where: { orderId } })).toBe(0);

      const reconciled = await deliveryRepository.findCodReconciliationRecords({
        orderId,
      });
      expect(reconciled.total).toBe(1);
      expect(reconciled.items[0]).toMatchObject({
        orderId,
        orderStatus: 'DELIVERED',
        discrepancy: false,
      });
      expect(reconciled.items[0].deliveredAt).toEqual(
        persistedAssignment.deliveredAt,
      );
    });

    it('does not transition an order that is not SHIPPED', async () => {
      const orderId = await createOrder({ status: 'CONFIRMED' });
      const assignment = await createAssignment(
        orderId,
        staffAId,
        { status: DeliveryStatus.OUT_FOR_DELIVERY },
      );

      const response = await updateAssignmentStatus(
        assignment.id,
        staffAId,
        DeliveryStatus.DELIVERED,
      );

      expect(response.status).toBe(HttpStatus.CONFLICT);
      expect(
        (await prisma.order.findUniqueOrThrow({ where: { id: orderId } }))
          .status,
      ).toBe('CONFIRMED');
      expect(
        (
          await prisma.deliveryAssignment.findUniqueOrThrow({
            where: { id: assignment.id },
          })
        ).status,
      ).toBe(DeliveryStatus.OUT_FOR_DELIVERY);
    });

    it.each([
      ['order', 'orders'],
      ['assignment', 'delivery_assignments'],
    ] as const)(
      'rolls back both changes when the %s update fails',
      async (failureTarget, table) => {
        const { orderId, assignment } = await createShippedDelivery();
        const targetId = failureTarget === 'order' ? orderId : assignment.id;

        try {
          await installDeliveryFailureTrigger(table, targetId);

          const response = await updateAssignmentStatus(
            assignment.id,
            staffAId,
            DeliveryStatus.DELIVERED,
          );
          expect(response.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
        } finally {
          await removeDeliveryFailureTrigger();
        }

        expect(
          (await prisma.order.findUniqueOrThrow({ where: { id: orderId } }))
            .status,
        ).toBe('SHIPPED');
        expect(
          (
            await prisma.deliveryAssignment.findUniqueOrThrow({
              where: { id: assignment.id },
            })
          ).status,
        ).toBe(DeliveryStatus.OUT_FOR_DELIVERY);
      },
    );

    it('serializes concurrent delivery completion without inconsistent state', async () => {
      const { orderId, assignment } = await createShippedDelivery();

      const responses = await Promise.all([
        updateAssignmentStatus(
          assignment.id,
          staffAId,
          DeliveryStatus.DELIVERED,
        ),
        updateAssignmentStatus(
          assignment.id,
          staffAId,
          DeliveryStatus.DELIVERED,
        ),
      ]);

      expect(responses.map(({ status }) => status).sort()).toEqual([
        HttpStatus.OK,
        HttpStatus.BAD_REQUEST,
      ]);
      expect(
        (await prisma.order.findUniqueOrThrow({ where: { id: orderId } }))
          .status,
      ).toBe('DELIVERED');
      expect(
        (
          await prisma.deliveryAssignment.findUniqueOrThrow({
            where: { id: assignment.id },
          })
        ).status,
      ).toBe(DeliveryStatus.DELIVERED);
    });

    it('keeps delivered COD collection ownership, amount, currency, and duplicate guards', async () => {
      const { orderId, assignment } = await createShippedDelivery();
      expect(
        (
          await updateAssignmentStatus(
            assignment.id,
            staffAId,
            DeliveryStatus.DELIVERED,
          )
        ).status,
      ).toBe(HttpStatus.OK);

      const otherStaff = await collect(assignment.id, staffBId, {
        amount: '10.00',
        currency: 'USD',
      });
      expect(otherStaff.status).toBe(HttpStatus.FORBIDDEN);

      const wrongAmount = await collect(assignment.id, staffAId, {
        amount: '9.99',
        currency: 'USD',
      });
      expect(wrongAmount.status).toBe(HttpStatus.BAD_REQUEST);

      const wrongCurrency = await collect(assignment.id, staffAId, {
        amount: '10.00',
        currency: 'EUR',
      });
      expect(wrongCurrency.status).toBe(HttpStatus.BAD_REQUEST);

      const first = await collect(assignment.id, staffAId, {
        amount: '10.00',
        currency: 'USD',
      });
      const duplicate = await collect(assignment.id, staffAId, {
        amount: '10.00',
        currency: 'USD',
      });
      expect(first.status).toBe(HttpStatus.CREATED);
      expect(duplicate.status).toBe(HttpStatus.CONFLICT);
      expect(await prisma.codCollection.count({ where: { orderId } })).toBe(1);
      expect(await prisma.payment.count({ where: { orderId } })).toBe(0);
    });

    it('rejects COD collection from a returned terminal assignment', async () => {
      const orderId = await createOrder();
      const assignment = await createAssignment(
        orderId,
        staffAId,
        { status: DeliveryStatus.RETURNED, endedAt: new Date() },
      );

      const response = await collect(assignment.id, staffAId, {
        amount: '10.00',
        currency: 'USD',
      });

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
      expect(await prisma.codCollection.count({ where: { orderId } })).toBe(0);
    });
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

    it('refuses a returned terminal assignment even if endedAt was not set', async () => {
      const orderId = await createOrder();
      const assignment = await createAssignment(orderId, staffAId, {
        status: DeliveryStatus.RETURNED,
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

  describe('COD collection history and summary (PostgreSQL)', () => {
    const getCodCollections = (user: string, query: Record<string, string>) => {
      const qs = Object.entries(query)
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join('&');
      return api('GET', `/delivery/staff/cod-collections${qs ? `?${qs}` : ''}`, {
        user,
      });
    };

    const getCodCollectionsSummary = (user: string, query: Record<string, string>) => {
      const qs = Object.entries(query)
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join('&');
      return api('GET', `/delivery/staff/cod-collections/summary${qs ? `?${qs}` : ''}`, {
        user,
      });
    };

    const createCodCollection = async (options: {
      staffId: string;
      amount?: string;
      currency?: string;
      collectedAt?: Date;
      notes?: string;
    }): Promise<string> => {
      const orderId = await createOrder({
        currency: options.currency ?? 'USD',
        totalAmount: options.amount ?? '10.00',
      });
      await createAssignment(orderId, options.staffId);
      const collection = await prisma.codCollection.create({
        data: {
          orderId,
          collectedById: options.staffId,
          amount: options.amount ?? '10.00',
          currency: options.currency ?? 'USD',
          collectedAt: options.collectedAt ?? new Date(),
          notes: options.notes ?? null,
        },
        select: { id: true },
      });
      return collection.id;
    };

    afterEach(async () => {
      await prisma.codCollection.deleteMany({
        where: {
          collectedById: { in: [staffAId, staffBId, inactiveStaffId] },
        },
      });
    });

    beforeEach(async () => {
      await prisma.codCollection.deleteMany({
        where: {
          collectedById: { in: [staffAId, staffBId, inactiveStaffId] },
        },
      });
    });

    it('lets a staff member view only their own collection history', async () => {
      await createCodCollection({
        staffId: staffAId,
        amount: '10.00',
        currency: 'USD',
        collectedAt: new Date('2026-01-05T10:00:00Z'),
      });
      await createCodCollection({
        staffId: staffAId,
        amount: '25.50',
        currency: 'USD',
        collectedAt: new Date('2026-01-06T10:00:00Z'),
      });
      await createCodCollection({
        staffId: staffBId,
        amount: '7.00',
        currency: 'USD',
        collectedAt: new Date('2026-01-07T10:00:00Z'),
      });

      const res = await getCodCollections(staffAId, {});

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.items).toHaveLength(2);
      expect(
        res.body.items.every((item: unknown) => (item as { collectedById: string }).collectedById === staffAId),
      ).toBe(true);
      expect(res.body.items[0].collectionId).toBeDefined();
      expect(res.body.items[0].orderNumber).toBeDefined();
      expect(res.body.items[0].amount).toBe('25.50');
      expect(res.body.items[1].amount).toBe('10.00');
      expect(res.body.pagination).toEqual({
        page: 1,
        limit: 20,
        total: 2,
        totalPages: 1,
      });
    });

    it('does not expose another staff member collections', async () => {
      await createCodCollection({ staffId: staffAId, amount: '10.00' });

      const res = await getCodCollections(staffBId, {});

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.items).toHaveLength(0);
      expect(res.body.pagination).toEqual({
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
      });
    });

    it('paginates collections deterministically', async () => {
      await createCodCollection({
        staffId: staffAId,
        collectedAt: new Date('2026-01-01T10:00:00Z'),
      });
      await createCodCollection({
        staffId: staffAId,
        collectedAt: new Date('2026-01-02T10:00:00Z'),
      });
      await createCodCollection({
        staffId: staffAId,
        collectedAt: new Date('2026-01-03T10:00:00Z'),
      });

      const first = await getCodCollections(staffAId, { page: '1', limit: '2' });
      expect(first.status).toBe(HttpStatus.OK);
      expect(first.body.items).toHaveLength(2);
      expect(first.body.pagination).toEqual({
        page: 1,
        limit: 2,
        total: 3,
        totalPages: 2,
      });

      const second = await getCodCollections(staffAId, { page: '2', limit: '2' });
      expect(second.status).toBe(HttpStatus.OK);
      expect(second.body.items).toHaveLength(1);
      expect(second.body.pagination.page).toBe(2);
    });

    it('filters collections by date range', async () => {
      await createCodCollection({
        staffId: staffAId,
        collectedAt: new Date('2026-01-05T10:00:00Z'),
      });
      await createCodCollection({
        staffId: staffAId,
        collectedAt: new Date('2026-01-10T10:00:00Z'),
      });
      await createCodCollection({
        staffId: staffAId,
        collectedAt: new Date('2026-02-01T10:00:00Z'),
      });

      const res = await getCodCollections(staffAId, {
        startDate: '2026-01-01',
        endDate: '2026-01-31',
      });

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.items).toHaveLength(2);
      expect(
        res.body.items.every((item: unknown) => {
          const collectedAt = new Date((item as { collectedAt: string }).collectedAt);
          return (
            collectedAt >= new Date('2026-01-01T00:00:00Z') &&
            collectedAt <= new Date('2026-01-31T23:59:59.999Z')
          );
        }),
      ).toBe(true);
    });

    it('filters collections by currency', async () => {
      await createCodCollection({ staffId: staffAId, currency: 'USD', amount: '10.00' });
      await createCodCollection({ staffId: staffAId, currency: 'KHR', amount: '40000' });
      await createCodCollection({ staffId: staffAId, currency: 'KHR', amount: '20000' });

      const res = await getCodCollections(staffAId, { currency: 'KHR' });

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.items).toHaveLength(2);
      expect(
        res.body.items.every((item: unknown) => (item as { currency: string }).currency === 'KHR'),
      ).toBe(true);
      expect(res.body.pagination.total).toBe(2);
    });

    it('rejects a startDate after endDate', async () => {
      const res = await getCodCollections(staffAId, {
        startDate: '2026-02-01',
        endDate: '2026-01-01',
      });
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('returns an empty history with correct pagination', async () => {
      const res = await getCodCollections(staffBId, {});

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.items).toEqual([]);
      expect(res.body.pagination).toEqual({
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
      });
    });

    it('calculates summary totals per currency without mixing them', async () => {
      await createCodCollection({
        staffId: staffAId,
        currency: 'USD',
        amount: '10.00',
        collectedAt: new Date('2026-01-05T10:00:00Z'),
      });
      await createCodCollection({
        staffId: staffAId,
        currency: 'USD',
        amount: '15.50',
        collectedAt: new Date('2026-01-10T10:00:00Z'),
      });
      await createCodCollection({
        staffId: staffAId,
        currency: 'KHR',
        amount: '40000',
        collectedAt: new Date('2026-01-15T10:00:00Z'),
      });

      const res = await getCodCollectionsSummary(staffAId, {});

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.totalCollections).toBe(3);
      expect(res.body.firstCollectionAt).toBe('2026-01-05T10:00:00.000Z');
      expect(res.body.lastCollectionAt).toBe('2026-01-15T10:00:00.000Z');

      const byCurrency = Object.fromEntries(
        res.body.totalsByCurrency.map((entry: { currency: string; totalAmount: string; count: number }) => [
          entry.currency,
          entry,
        ]),
      );
      expect(byCurrency['USD']).toEqual({
        currency: 'USD',
        totalAmount: '25.50',
        count: 2,
      });
      expect(byCurrency['KHR']).toEqual({
        currency: 'KHR',
        totalAmount: '40000.00',
        count: 1,
      });
    });

    it('never aggregates different currencies into one total', async () => {
      await createCodCollection({ staffId: staffAId, currency: 'USD', amount: '100.00' });
      await createCodCollection({ staffId: staffAId, currency: 'KHR', amount: '400000' });

      const res = await getCodCollectionsSummary(staffAId, {});

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.totalsByCurrency).toHaveLength(2);
      const amounts = res.body.totalsByCurrency.map(
        (entry: { totalAmount: string }) => entry.totalAmount,
      );
      expect(amounts).toContain('100.00');
      expect(amounts).toContain('400000.00');
      expect(amounts).not.toContain('100400000.00');
    });

    it('aggregates collections by day', async () => {
      await createCodCollection({
        staffId: staffAId,
        currency: 'USD',
        amount: '10.00',
        collectedAt: new Date('2026-01-05T10:00:00Z'),
      });
      await createCodCollection({
        staffId: staffAId,
        currency: 'USD',
        amount: '5.00',
        collectedAt: new Date('2026-01-05T14:00:00Z'),
      });
      await createCodCollection({
        staffId: staffAId,
        currency: 'USD',
        amount: '7.00',
        collectedAt: new Date('2026-01-06T09:00:00Z'),
      });

      const res = await getCodCollectionsSummary(staffAId, { period: 'daily' });

      expect(res.status).toBe(HttpStatus.OK);
      const byPeriod = Object.fromEntries(
        res.body.periodBreakdown.map((entry: { period: string }) => [entry.period, entry]),
      );
      expect(byPeriod['2026-01-05']).toEqual({
        period: '2026-01-05',
        currency: 'USD',
        totalAmount: '15.00',
        count: 2,
      });
      expect(byPeriod['2026-01-06']).toEqual({
        period: '2026-01-06',
        currency: 'USD',
        totalAmount: '7.00',
        count: 1,
      });
    });

    it('aggregates collections by week', async () => {
      await createCodCollection({
        staffId: staffAId,
        currency: 'USD',
        amount: '10.00',
        collectedAt: new Date('2026-01-05T10:00:00Z'),
      });
      await createCodCollection({
        staffId: staffAId,
        currency: 'USD',
        amount: '5.00',
        collectedAt: new Date('2026-01-11T10:00:00Z'),
      });
      await createCodCollection({
        staffId: staffAId,
        currency: 'USD',
        amount: '7.00',
        collectedAt: new Date('2026-01-12T10:00:00Z'),
      });

      const res = await getCodCollectionsSummary(staffAId, { period: 'weekly' });

      expect(res.status).toBe(HttpStatus.OK);
      const byPeriod = Object.fromEntries(
        res.body.periodBreakdown.map((entry: { period: string }) => [entry.period, entry]),
      );
      expect(byPeriod['2026-01-05']).toEqual({
        period: '2026-01-05',
        currency: 'USD',
        totalAmount: '15.00',
        count: 2,
      });
      expect(byPeriod['2026-01-12']).toEqual({
        period: '2026-01-12',
        currency: 'USD',
        totalAmount: '7.00',
        count: 1,
      });
    });

    it('aggregates collections by month', async () => {
      await createCodCollection({
        staffId: staffAId,
        currency: 'USD',
        amount: '10.00',
        collectedAt: new Date('2026-01-05T10:00:00Z'),
      });
      await createCodCollection({
        staffId: staffAId,
        currency: 'USD',
        amount: '5.00',
        collectedAt: new Date('2026-01-20T10:00:00Z'),
      });
      await createCodCollection({
        staffId: staffAId,
        currency: 'USD',
        amount: '7.00',
        collectedAt: new Date('2026-02-01T10:00:00Z'),
      });

      const res = await getCodCollectionsSummary(staffAId, { period: 'monthly' });

      expect(res.status).toBe(HttpStatus.OK);
      const byPeriod = Object.fromEntries(
        res.body.periodBreakdown.map((entry: { period: string }) => [entry.period, entry]),
      );
      expect(byPeriod['2026-01']).toEqual({
        period: '2026-01',
        currency: 'USD',
        totalAmount: '15.00',
        count: 2,
      });
      expect(byPeriod['2026-02']).toEqual({
        period: '2026-02',
        currency: 'USD',
        totalAmount: '7.00',
        count: 1,
      });
    });

    it('refuses an inactive delivery staff member on history', async () => {
      const res = await getCodCollections(inactiveStaffId, {});
      expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it('refuses an inactive delivery staff member on summary', async () => {
      const res = await getCodCollectionsSummary(inactiveStaffId, {});
      expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
    });
  });

  describe('Admin COD collection management (PostgreSQL)', () => {
    const adminGet = (path: string, query: Record<string, string> = {}) => {
      const qs = Object.entries(query)
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join('&');
      return api('GET', `/admin/cod-collections${path}${qs ? `?${qs}` : ''}`, {
        user: adminId,
      });
    };

    const unauthenticatedGet = (path: string) =>
      api('GET', `/admin/cod-collections${path}`);

    const asStaffGet = (path: string) =>
      api('GET', `/admin/cod-collections${path}`, { user: staffAId });

    const createAdminCollection = async (options: {
      staffId: string;
      amount?: string;
      currency?: string;
      collectedAt?: Date;
      orderNumberOverride?: string;
    }): Promise<string> => {
      const orderId = await createOrder({
        currency: options.currency ?? 'USD',
        totalAmount: options.amount ?? '10.00',
      });
      await createAssignment(orderId, options.staffId);
      const collection = await prisma.codCollection.create({
        data: {
          orderId,
          collectedById: options.staffId,
          amount: options.amount ?? '10.00',
          currency: options.currency ?? 'USD',
          collectedAt: options.collectedAt ?? new Date(),
          notes: null,
        },
        select: { id: true },
      });
      return collection.id;
    };

    beforeEach(async () => {
      await prisma.codCollection.deleteMany({
        where: {
          collectedById: { in: [staffAId, staffBId] },
        },
      });
    });

    it('lets an administrator list every collection', async () => {
      await createAdminCollection({
        staffId: staffAId,
        amount: '10.00',
        currency: 'USD',
        collectedAt: new Date('2026-01-05T10:00:00Z'),
      });
      await createAdminCollection({
        staffId: staffBId,
        amount: '25.50',
        currency: 'KHR',
        collectedAt: new Date('2026-01-06T10:00:00Z'),
      });

      const res = await adminGet('');

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.items).toHaveLength(2);
      expect(res.body.pagination).toEqual({
        page: 1,
        limit: 20,
        total: 2,
        totalPages: 1,
      });
      expect(
        res.body.items.every((item: unknown) => {
          const row = item as { collectedById: string };
          return row.collectedById === staffAId || row.collectedById === staffBId;
        }),
      ).toBe(true);
    });

    it('refuses a delivery staff member with 403', async () => {
      const res = await asStaffGet('');
      expect(res.status).toBe(HttpStatus.FORBIDDEN);
    });

    it('refuses an unauthenticated request with 401', async () => {
      const res = await unauthenticatedGet('');
      expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it('paginates collections deterministically', async () => {
      await createAdminCollection({
        staffId: staffAId,
        collectedAt: new Date('2026-01-01T10:00:00Z'),
      });
      await createAdminCollection({
        staffId: staffAId,
        collectedAt: new Date('2026-01-02T10:00:00Z'),
      });
      await createAdminCollection({
        staffId: staffAId,
        collectedAt: new Date('2026-01-03T10:00:00Z'),
      });

      const first = await adminGet('', { page: '1', limit: '2' });
      expect(first.status).toBe(HttpStatus.OK);
      expect(first.body.items).toHaveLength(2);
      expect(first.body.pagination).toEqual({
        page: 1,
        limit: 2,
        total: 3,
        totalPages: 2,
      });

      const second = await adminGet('', { page: '2', limit: '2' });
      expect(second.status).toBe(HttpStatus.OK);
      expect(second.body.items).toHaveLength(1);
    });

    it('filters collections by staff member', async () => {
      await createAdminCollection({ staffId: staffAId, amount: '10.00' });
      await createAdminCollection({ staffId: staffBId, amount: '20.00' });

      const res = await adminGet('', { staffId: staffAId });

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.items).toHaveLength(1);
      expect(
        res.body.items.every(
          (item: unknown) => (item as { collectedById: string }).collectedById === staffAId,
        ),
      ).toBe(true);
    });

    it('filters collections by date range', async () => {
      await createAdminCollection({
        staffId: staffAId,
        collectedAt: new Date('2026-01-05T10:00:00Z'),
      });
      await createAdminCollection({
        staffId: staffAId,
        collectedAt: new Date('2026-02-01T10:00:00Z'),
      });

      const res = await adminGet('', {
        startDate: '2026-01-01',
        endDate: '2026-01-31',
      });

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.items).toHaveLength(1);
    });

    it('filters collections by currency', async () => {
      await createAdminCollection({ staffId: staffAId, currency: 'USD', amount: '10.00' });
      await createAdminCollection({ staffId: staffAId, currency: 'KHR', amount: '40000' });

      const res = await adminGet('', { currency: 'KHR' });

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.items).toHaveLength(1);
      expect(
        (res.body.items[0] as { currency: string }).currency,
      ).toBe('KHR');
    });

    it('searches collections by order number', async () => {
      await createAdminCollection({ staffId: staffAId });

      const orderNumber = (
        await prisma.codCollection.findFirst({
          where: { collectedById: staffAId },
          include: { order: { select: { orderNumber: true } } },
        })
      )!.order.orderNumber;

      const res = await adminGet('', {
        orderNumber: orderNumber.slice(0, 6),
      });

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.items).toHaveLength(1);
    });

    it('returns collection details with staff and payment information', async () => {
      const collectionId = await createAdminCollection({
        staffId: staffAId,
        amount: '10.00',
        currency: 'USD',
      });

      const res = await adminGet(`/${collectionId}`);

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.collectionId).toBe(collectionId);
      expect(res.body.amount).toBe('10.00');
      expect(res.body.currency).toBe('USD');
      expect(res.body.collectedAt).toBeDefined();
      expect(res.body.collectedBy).toEqual({
        id: staffAId,
        firstName: 'COD',
        lastName: expect.stringContaining('staff-a'),
        email: expect.stringContaining('@example.test'),
      });
      expect(res.body.orderId).toBeDefined();
      expect(res.body.orderNumber).toBeDefined();
      // Payment is null because none was linked; present but null.
      expect(res.body.payment).toBeNull();
    });

    it('returns collection details including the linked payment', async () => {
      const orderId = await createOrder({ currency: 'USD', totalAmount: '10.00' });
      await createAssignment(orderId, staffAId);
      const payment = await createPayment(orderId);
      const collection = await prisma.codCollection.create({
        data: {
          orderId,
          paymentId: payment.id,
          collectedById: staffAId,
          amount: '10.00',
          currency: 'USD',
        },
        select: { id: true },
      });

      const res = await adminGet(`/${collection.id}`);

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.payment).toEqual({
        id: payment.id,
        status: expect.any(String),
        amount: '10.00',
        currency: 'USD',
        paymentMethod: null,
        paidAt: null,
      });
    });

    it('returns 404 for a missing collection', async () => {
      const res = await adminGet(`/${randomUUID()}`);
      expect(res.status).toBe(HttpStatus.NOT_FOUND);
    });

    it('calculates a multi-currency summary without mixing currencies', async () => {
      await createAdminCollection({
        staffId: staffAId,
        currency: 'USD',
        amount: '10.00',
        collectedAt: new Date('2026-01-05T10:00:00Z'),
      });
      await createAdminCollection({
        staffId: staffAId,
        currency: 'KHR',
        amount: '40000',
        collectedAt: new Date('2026-01-10T10:00:00Z'),
      });

      const res = await adminGet('/summary');

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.totalCollections).toBe(2);
      expect(res.body.firstCollectionAt).toBe('2026-01-05T10:00:00.000Z');
      expect(res.body.lastCollectionAt).toBe('2026-01-10T10:00:00.000Z');

      const byCurrency = Object.fromEntries(
        res.body.totalsByCurrency.map((entry: { currency: string }) => [
          entry.currency,
          entry,
        ]),
      );
      expect(byCurrency['USD']).toEqual({
        currency: 'USD',
        totalAmount: '10.00',
        count: 1,
      });
      expect(byCurrency['KHR']).toEqual({
        currency: 'KHR',
        totalAmount: '40000.00',
        count: 1,
      });
    });

    it('never aggregates different currencies into one total', async () => {
      await createAdminCollection({
        staffId: staffAId,
        currency: 'USD',
        amount: '100.00',
      });
      await createAdminCollection({
        staffId: staffBId,
        currency: 'KHR',
        amount: '400000',
      });

      const res = await adminGet('/summary');

      expect(res.status).toBe(HttpStatus.OK);
      const amounts = res.body.totalsByCurrency.map(
        (entry: { totalAmount: string }) => entry.totalAmount,
      );
      expect(amounts).toContain('100.00');
      expect(amounts).toContain('400000.00');
      expect(amounts).not.toContain('100400000.00');
    });

    it('breaks collections down by day, week and month', async () => {
      await createAdminCollection({
        staffId: staffAId,
        currency: 'USD',
        amount: '10.00',
        collectedAt: new Date('2026-01-05T10:00:00Z'),
      });
      await createAdminCollection({
        staffId: staffAId,
        currency: 'USD',
        amount: '5.00',
        collectedAt: new Date('2026-01-05T14:00:00Z'),
      });
      await createAdminCollection({
        staffId: staffAId,
        currency: 'USD',
        amount: '7.00',
        collectedAt: new Date('2026-01-06T10:00:00Z'),
      });
      await createAdminCollection({
        staffId: staffAId,
        currency: 'USD',
        amount: '3.00',
        collectedAt: new Date('2026-01-12T10:00:00Z'),
      });
      await createAdminCollection({
        staffId: staffAId,
        currency: 'USD',
        amount: '9.00',
        collectedAt: new Date('2026-02-01T10:00:00Z'),
      });

      const daily = await adminGet('/summary', { period: 'daily' });
      expect(daily.status).toBe(HttpStatus.OK);
      const dailyByPeriod = Object.fromEntries(
        daily.body.periodBreakdown.map((entry: { period: string }) => [
          entry.period,
          entry,
        ]),
      );
      expect(dailyByPeriod['2026-01-05']).toEqual({
        period: '2026-01-05',
        currency: 'USD',
        totalAmount: '15.00',
        count: 2,
      });
      expect(dailyByPeriod['2026-01-06']).toEqual({
        period: '2026-01-06',
        currency: 'USD',
        totalAmount: '7.00',
        count: 1,
      });

      const weekly = await adminGet('/summary', { period: 'weekly' });
      expect(weekly.status).toBe(HttpStatus.OK);
      const weeklyByPeriod = Object.fromEntries(
        weekly.body.periodBreakdown.map((entry: { period: string }) => [
          entry.period,
          entry,
        ]),
      );
      // 2026-01-05 is a Monday; 2026-01-07 falls in the same week, 2026-01-12
      // starts the next week.
      expect(weeklyByPeriod['2026-01-05']).toEqual({
        period: '2026-01-05',
        currency: 'USD',
        totalAmount: '22.00',
        count: 3,
      });
      expect(weeklyByPeriod['2026-01-12']).toEqual({
        period: '2026-01-12',
        currency: 'USD',
        totalAmount: '3.00',
        count: 1,
      });

      const monthly = await adminGet('/summary', { period: 'monthly' });
      expect(monthly.status).toBe(HttpStatus.OK);
      const monthlyByPeriod = Object.fromEntries(
        monthly.body.periodBreakdown.map((entry: { period: string }) => [
          entry.period,
          entry,
        ]),
      );
      expect(monthlyByPeriod['2026-01']).toEqual({
        period: '2026-01',
        currency: 'USD',
        totalAmount: '25.00',
        count: 4,
      });
      expect(monthlyByPeriod['2026-02']).toEqual({
        period: '2026-02',
        currency: 'USD',
        totalAmount: '9.00',
        count: 1,
      });
    });

    it('breaks collections down by staff and currency', async () => {
      await createAdminCollection({
        staffId: staffAId,
        currency: 'USD',
        amount: '10.00',
      });
      await createAdminCollection({
        staffId: staffBId,
        currency: 'USD',
        amount: '20.00',
      });

      const res = await adminGet('/summary');

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.staffBreakdown).toHaveLength(2);
      const byStaff = Object.fromEntries(
        res.body.staffBreakdown.map((entry: { staffId: string }) => [
          entry.staffId,
          entry,
        ]),
      );
      expect(byStaff[staffAId]).toEqual({
        staffId: staffAId,
        staff: {
          id: staffAId,
          firstName: 'COD',
          lastName: expect.stringContaining('staff-a'),
          email: expect.stringContaining('@example.test'),
        },
        currency: 'USD',
        totalAmount: '10.00',
        count: 1,
      });
      expect(byStaff[staffBId]).toEqual({
        staffId: staffBId,
        staff: {
          id: staffBId,
          firstName: 'COD',
          lastName: expect.stringContaining('staff-b'),
          email: expect.stringContaining('@example.test'),
        },
        currency: 'USD',
        totalAmount: '20.00',
        count: 1,
      });
    });

    it('returns an empty summary with correct shape', async () => {
      const res = await adminGet('/summary');

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.totalCollections).toBe(0);
      expect(res.body.totalsByCurrency).toEqual([]);
      expect(res.body.firstCollectionAt).toBeNull();
      expect(res.body.lastCollectionAt).toBeNull();
      expect(res.body.periodBreakdown).toEqual([]);
      expect(res.body.staffBreakdown).toEqual([]);
    });

    it('does not expose customer PII in collection details', async () => {
      const collectionId = await createAdminCollection({ staffId: staffAId });

      const res = await adminGet(`/${collectionId}`);

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body).not.toHaveProperty('user');
      expect(res.body).not.toHaveProperty('customer');
      expect(res.body).not.toHaveProperty('shipping');
      expect(res.body.orderId).toEqual(expect.any(String));
      expect(res.body.orderNumber).toEqual(expect.any(String));
    });
  });

  describe('DeliveryRepository COD financial reconciliation queries (PostgreSQL)', () => {
    it('findCodReconciliationRecords accurately reconciles delivered COD orders', async () => {
      // 1. Delivered COD order with valid collection
      const order1Id = await createOrder({ status: 'DELIVERED', totalAmount: '100.00' });
      await createAssignment(order1Id, staffAId, {
        status: DeliveryStatus.DELIVERED,
      });
      await prisma.deliveryAssignment.updateMany({
        where: { orderId: order1Id, status: DeliveryStatus.DELIVERED },
        data: { deliveredAt: new Date('2026-10-15T10:00:00Z') },
      });
      await prisma.codCollection.create({
        data: {
          orderId: order1Id,
          collectedById: staffAId,
          amount: '100.00',
          currency: 'USD',
          collectedAt: new Date('2026-10-15T10:05:00Z'),
        },
      });

      // 2. Delivered COD order without collection (missing-collection)
      const order2Id = await createOrder({ status: 'DELIVERED', totalAmount: '50.00' });
      await createAssignment(order2Id, staffAId, {
        status: DeliveryStatus.DELIVERED,
      });
      await prisma.deliveryAssignment.updateMany({
        where: { orderId: order2Id, status: DeliveryStatus.DELIVERED },
        data: { deliveredAt: new Date('2026-10-15T11:00:00Z') },
      });

      // 3. Delivered COD order with amount mismatch (order 80, collected 60)
      const order3Id = await createOrder({ status: 'DELIVERED', totalAmount: '80.00' });
      await createAssignment(order3Id, staffBId, {
        status: DeliveryStatus.DELIVERED,
      });
      await prisma.deliveryAssignment.updateMany({
        where: { orderId: order3Id, status: DeliveryStatus.DELIVERED },
        data: { deliveredAt: new Date('2026-10-15T12:00:00Z') },
      });
      await prisma.codCollection.create({
        data: {
          orderId: order3Id,
          collectedById: staffBId,
          amount: '60.00',
          currency: 'USD',
          collectedAt: new Date('2026-10-15T12:05:00Z'),
        },
      });

      // 4. Delivered COD order with currency mismatch (order USD, collection KHR)
      const order4Id = await createOrder({ status: 'DELIVERED', totalAmount: '40.00', currency: 'USD' });
      await createAssignment(order4Id, staffBId, {
        status: DeliveryStatus.DELIVERED,
      });
      await prisma.deliveryAssignment.updateMany({
        where: { orderId: order4Id, status: DeliveryStatus.DELIVERED },
        data: { deliveredAt: new Date('2026-10-15T13:00:00Z') },
      });
      await prisma.codCollection.create({
        data: {
          orderId: order4Id,
          collectedById: staffBId,
          amount: '160000.00',
          currency: 'KHR',
          collectedAt: new Date('2026-10-15T13:05:00Z'),
        },
      });

      // 5. Delivered COD order with delivered_at IS NULL (data-integrity test)
      const order5Id = await createOrder({ status: 'DELIVERED', totalAmount: '30.00', currency: 'USD' });
      await createAssignment(order5Id, staffAId, {
        status: DeliveryStatus.DELIVERED,
      });
      await prisma.deliveryAssignment.updateMany({
        where: { orderId: order5Id, status: DeliveryStatus.DELIVERED },
        data: { deliveredAt: null },
      });

      // Query records scoped to order 1
      const res = await deliveryRepository.findCodReconciliationRecords({
        orderId: order1Id,
      });
      expect(res.total).toBe(1);
      expect(res.items[0].discrepancy).toBe(false);
      expect(res.items[0].discrepancyType).toBeNull();
      expect(res.items[0].expectedAmount.toString()).toBe('100');
      expect(res.items[0].collectedAmount?.toString()).toBe('100');
      expect(res.items[0].currency).toBe('USD');
      expect(res.items[0].deliveredAt).toEqual(new Date('2026-10-15T10:00:00Z'));

      // Test uncollected query
      const uncollectedRes = await deliveryRepository.findUncollectedDeliveredCodOrders({
        orderId: order2Id,
      });
      expect(uncollectedRes.total).toBe(1);
      expect(uncollectedRes.items[0].orderId).toBe(order2Id);
      expect(uncollectedRes.items[0].expectedAmount.toString()).toBe('50');
      expect(uncollectedRes.items[0].deliveryStaffId).toBe(staffAId);

      // Test discrepancies query for order 3 (amount mismatch)
      const disc3 = await deliveryRepository.findCodReconciliationDiscrepancies({
        orderId: order3Id,
      });
      expect(disc3.total).toBe(1);
      expect(disc3.items[0].discrepancyType).toBe('amount-mismatch');
      expect(disc3.items[0].totalAmount.toString()).toBe('80');
      expect(disc3.items[0].collectedAmount?.toString()).toBe('60');

      // Test discrepancies query for order 4 (currency mismatch)
      const disc4 = await deliveryRepository.findCodReconciliationDiscrepancies({
        orderId: order4Id,
      });
      expect(disc4.total).toBe(1);
      expect(disc4.items[0].discrepancyType).toBe('currency-mismatch');
      expect(disc4.items[0].currency).toBe('USD');
      expect(disc4.items[0].collectionCurrency).toBe('KHR');
      expect(disc4.items[0].expectedAmount.toString()).toBe('40');
      expect(disc4.items[0].actualAmount?.toString()).toBe('160000');

      // Test summarizeCodReconciliation with currency mismatch:
      // USD expected is not reduced by KHR collection; KHR collection is reported under KHR
      const summary4 = await deliveryRepository.summarizeCodReconciliation({
        orderId: order4Id,
      });
      expect(summary4.totalCollections).toBe(1);
      expect(summary4.discrepancyCount).toBe(1);
      const usdTotal = summary4.totalsByCurrency.find((t) => t.currency === 'USD');
      const khrTotal = summary4.totalsByCurrency.find((t) => t.currency === 'KHR');
      expect(usdTotal).toBeDefined();
      expect(usdTotal?.expectedAmount.toString()).toBe('40');
      expect(usdTotal?.collectedAmount.toString()).toBe('0');
      expect(usdTotal?.outstandingAmount.toString()).toBe('40');
      expect(khrTotal).toBeDefined();
      expect(khrTotal?.expectedAmount.toString()).toBe('0');
      expect(khrTotal?.collectedAmount.toString()).toBe('160000');
      expect(khrTotal?.outstandingAmount.toString()).toBe('0');

      // Test order 5 with delivered_at IS NULL
      const res5 = await deliveryRepository.findCodReconciliationRecords({
        orderId: order5Id,
      });
      expect(res5.total).toBe(1);
      expect(res5.items[0].deliveredAt).toBeNull();

      // Date range filtering strictly excludes undated orders without inventing a timestamp
      const res5DateFiltered = await deliveryRepository.findCodReconciliationRecords({
        orderId: order5Id,
        startDate: '2026-10-01T00:00:00Z',
        endDate: '2026-10-31T23:59:59Z',
      });
      expect(res5DateFiltered.total).toBe(0);

      // Test period reconciliation
      const periodRes = await deliveryRepository.summarizeCodReconciliationByPeriod({
        orderId: order1Id,
        period: 'daily',
      });
      expect(periodRes).toHaveLength(1);
      expect(periodRes[0].period).toBe('2026-10-15');
      expect(periodRes[0].expectedAmount.toString()).toBe('100');
      expect(periodRes[0].collectedAmount.toString()).toBe('100');
      expect(periodRes[0].outstandingAmount.toString()).toBe('0');

      // Test staff summary
      const staffRes = await deliveryRepository.summarizeCodReconciliationByStaff({
        orderId: order1Id,
      });
      expect(staffRes).toHaveLength(1);
      expect(staffRes[0].staffId).toBe(staffAId);
      expect(staffRes[0].expectedAmount.toString()).toBe('100');
      expect(staffRes[0].collectedAmount.toString()).toBe('100');
      expect(staffRes[0].outstandingAmount.toString()).toBe('0');
      expect(staffRes[0].count).toBe(1);
    });
  });
});
