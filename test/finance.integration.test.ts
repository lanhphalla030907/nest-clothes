import 'dotenv/config';
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DeliveryStatus, Role } from '../src/generated/prisma/enums.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { FinanceQueryDto } from '../src/finance/dto/finance-query.dto.js';
import { ProductProfitQueryDto } from '../src/finance/dto/product-profit-query.dto.js';
import { RankingsQueryDto } from '../src/finance/dto/rankings-query.dto.js';
import { RevenueTrendQueryDto } from '../src/finance/dto/revenue-trend-query.dto.js';
import { CashReconciliationQueryDto } from '../src/finance/dto/cash-reconciliation-query.dto.js';
import { FinanceRepository } from '../src/finance/finance.repository.js';
import { FinanceService } from '../src/finance/finance.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * Finance integration coverage against a real PostgreSQL database.
 *
 * The fixtures are deliberately small but each one is a rule the report must
 * get right: delivered versus booked recognition, COD collected before
 * delivery, an uncollected delivered COD order, a late payment on a cancelled
 * order, duplicate PAID attempts, a COD collection linked to a PAID payment,
 * product and free-shipping discounts, comparable, missing and mismatched cost
 * snapshots, two currencies, and a reporting-day boundary at 00:00
 * `Asia/Phnom_Penh`.
 */

const run = randomUUID().slice(0, 8);
const prisma = new PrismaService();
const repository = new FinanceRepository(prisma);
const service = new FinanceService(repository);

const userIds: string[] = [];
const orderIds: string[] = [];
const promotionIds: string[] = [];
const variantIds = new Map<string, string>();

let customerId: string;
let managerId: string;
let staffId: string;
let categoryId: string;
let productId: string;
let productPromotionId: string;
let shippingPromotionId: string;
let shippingProviderId: string;
let codAreaId: string;

const SKU = (letter: string) => `FIN-${run}-${letter}`;

async function createUser(label: string, role: Role): Promise<string> {
  const id = randomUUID();
  await prisma.user.create({
    data: {
      id,
      firstName: 'Finance',
      lastName: `${label}-${run}`,
      email: `finance-${run}-${label}-${id.slice(0, 8)}@example.test`,
      passwordHash: 'not-used-by-integration-tests',
      status: 'ACTIVE',
      role,
    },
  });
  userIds.push(id);
  return id;
}

async function createVariant(letter: string): Promise<string> {
  const variant = await prisma.productVariant.create({
    data: {
      productId,
      sku: SKU(letter),
      price: '1.00',
      isActive: true,
    },
    select: { id: true },
  });
  variantIds.set(letter, variant.id);
  return variant.id;
}

interface OrderFixture {
  letter: string;
  status: string;
  subtotal: string;
  totalAmount: string;
  currency?: string;
  paymentMethod?: string;
  shippingFee?: string;
  discountAmount?: string;
  createdAt?: Date;
}

async function createOrder(fixture: OrderFixture): Promise<string> {
  const paymentMethod = fixture.paymentMethod ?? 'ABA_PAYWAY';
  const isCod = paymentMethod === 'COD';
  const order = await prisma.order.create({
    data: {
      userId: customerId,
      orderNumber: `FIN-${run}-${fixture.letter}`,
      status: fixture.status,
      subtotal: fixture.subtotal,
      shippingFee: fixture.shippingFee ?? '0.00',
      discountAmount: fixture.discountAmount ?? '0.00',
      totalAmount: fixture.totalAmount,
      currency: fixture.currency ?? 'USD',
      paymentMethod,
      shippingProviderId,
      shippingProviderCode: `FIN-SHIP-${run}`.toUpperCase(),
      shippingProviderName: 'Finance Shipping',
      ...(isCod
        ? {
            codAreaId,
            codAreaCode: `FIN-AREA-${run}`.toUpperCase(),
            codAreaName: 'Finance Area',
          }
        : {}),
      createdAt: fixture.createdAt,
      shippingRecipientName: 'Finance Fixture',
      shippingPhone: '+15555550123',
      shippingAddressLine1: '1 Finance Way',
      shippingCity: 'Testville',
      shippingCountryCode: 'US',
    },
    select: { id: true },
  });
  orderIds.push(order.id);
  return order.id;
}

interface ItemFixture {
  letter: string;
  quantity?: number;
  unitPrice: string;
  cost?: string | null;
  costCurrency?: string;
  currency?: string;
}

async function createItem(
  orderId: string,
  fixture: ItemFixture,
): Promise<void> {
  const quantity = fixture.quantity ?? 1;
  await prisma.orderItem.create({
    data: {
      orderId,
      variantId: variantIds.get(fixture.letter)!,
      productName: `Finance Product ${fixture.letter}`,
      sku: SKU(fixture.letter),
      variantOptionsSnapshot: {},
      unitPrice: fixture.unitPrice,
      quantity,
      lineTotal: new Prisma.Decimal(fixture.unitPrice).mul(quantity).toFixed(2),
      unitCostSnapshot:
        fixture.cost === null || fixture.cost === undefined
          ? null
          : fixture.cost,
      costCurrency:
        fixture.cost === null || fixture.cost === undefined
          ? null
          : (fixture.costCurrency ?? fixture.currency ?? 'USD'),
      costSource:
        fixture.cost === null || fixture.cost === undefined
          ? 'UNKNOWN'
          : 'VARIANT_AT_ORDER',
      costCapturedAt:
        fixture.cost === null || fixture.cost === undefined
          ? null
          : new Date('2026-09-01T00:00:00.000Z'),
    },
  });
}

async function createPayment(
  orderId: string,
  amount: string,
  currency: string,
  paidAt: Date,
  status = 'PAID',
): Promise<string> {
  const payment = await prisma.payment.create({
    data: {
      orderId,
      provider: 'ABA_PAYWAY',
      transactionId: randomUUID().replace(/-/g, '').slice(0, 20),
      status,
      amount,
      currency,
      paidAt: status === 'PAID' ? paidAt : null,
    },
    select: { id: true },
  });
  return payment.id;
}

async function createCollection(
  orderId: string,
  amount: string,
  currency: string,
  collectedAt: Date,
  paymentId?: string,
): Promise<void> {
  await prisma.codCollection.create({
    data: {
      orderId,
      paymentId,
      collectedById: staffId,
      amount,
      currency,
      collectedAt,
    },
  });
}

async function createDelivery(
  orderId: string,
  deliveredAt: Date,
): Promise<void> {
  await prisma.deliveryAssignment.create({
    data: {
      orderId,
      deliveryStaffId: staffId,
      assignedById: managerId,
      status: DeliveryStatus.DELIVERED,
      assignedAt: new Date(deliveredAt.getTime() - 60 * 60 * 1000),
      deliveredAt,
      endedAt: deliveredAt,
    },
  });
}

async function createUsage(
  orderId: string,
  promotionId: string,
  discountType: string,
  discountAmount: string,
  subtotalAtUse: string,
): Promise<void> {
  await prisma.promotionUsage.create({
    data: {
      promotionId,
      orderId,
      userId: customerId,
      nameSnapshot:
        discountType === 'FREE_SHIPPING' ? 'Free shipping' : 'Product discount',
      discountType,
      discountAmount,
      subtotalAtUse,
    },
  });
}

function query<T extends object>(dto: new () => T, values: Partial<T>): T {
  return Object.assign(new dto(), values);
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is not set — finance integration tests need PostgreSQL',
    );
  }
  const databaseName = new URL(process.env.DATABASE_URL).pathname;
  if (!/test/i.test(databaseName)) {
    throw new Error(
      `Refusing to run destructive finance fixtures against "${databaseName}"`,
    );
  }

  await prisma.$connect();
  customerId = await createUser('customer', Role.CUSTOMER);
  managerId = await createUser('manager', Role.DELIVERY_MANAGER);
  staffId = await createUser('staff', Role.DELIVERY_STAFF);

  const category = await prisma.category.create({
    data: {
      name: `Finance ${run}`,
      slug: `finance-${run}`,
    },
    select: { id: true },
  });
  categoryId = category.id;

  const product = await prisma.product.create({
    data: {
      categoryId,
      name: 'Finance Product',
      slug: `finance-product-${run}`,
      basePrice: '1.00',
      status: 'ACTIVE',
      isActive: true,
    },
    select: { id: true },
  });
  productId = product.id;

  for (const letter of 'ABCDEFGHIJKLMN'.split('')) {
    await createVariant(letter);
  }

  const provider = await prisma.shippingProvider.create({
    data: {
      code: `FIN-SHIP-${run}`.toUpperCase(),
      name: 'Finance Shipping',
      baseFee: '0.00',
      isActive: true,
      supportsCod: true,
    },
    select: { id: true },
  });
  shippingProviderId = provider.id;

  const codArea = await prisma.codArea.create({
    data: {
      code: `FIN-AREA-${run}`.toUpperCase(),
      name: 'Finance Area',
      codEnabled: true,
    },
    select: { id: true },
  });
  codAreaId = codArea.id;

  const productPromotion = await prisma.promotion.create({
    data: {
      code: `FINPROD-${run}`.toUpperCase(),
      name: 'Finance product discount',
      kind: 'COUPON',
      discountType: 'FIXED_AMOUNT',
      amountOff: '15.00',
      isActive: true,
    },
    select: { id: true },
  });
  productPromotionId = productPromotion.id;
  promotionIds.push(productPromotion.id);

  const shippingPromotion = await prisma.promotion.create({
    data: {
      name: 'Finance free shipping',
      kind: 'AUTOMATIC',
      discountType: 'FREE_SHIPPING',
      isActive: true,
    },
    select: { id: true },
  });
  shippingPromotionId = shippingPromotion.id;
  promotionIds.push(shippingPromotion.id);

  // A — delivered online, product discount + free shipping, comparable cost.
  const a = await createOrder({
    letter: 'A',
    status: 'DELIVERED',
    subtotal: '100.00',
    shippingFee: '10.00',
    discountAmount: '20.00',
    totalAmount: '90.00',
  });
  await createItem(a, {
    letter: 'A',
    quantity: 2,
    unitPrice: '50.00',
    cost: '30.00',
  });
  await createPayment(a, '90.00', 'USD', new Date('2026-09-09T10:00:00.000Z'));
  await createDelivery(a, new Date('2026-09-10T12:00:00.000Z'));
  await createUsage(a, productPromotionId, 'FIXED_AMOUNT', '15.00', '100.00');
  await createUsage(a, shippingPromotionId, 'FREE_SHIPPING', '5.00', '100.00');

  // B — delivered COD, collected after delivery.
  const b = await createOrder({
    letter: 'B',
    status: 'DELIVERED',
    subtotal: '50.00',
    totalAmount: '50.00',
    paymentMethod: 'COD',
  });
  await createItem(b, { letter: 'B', unitPrice: '50.00', cost: '20.00' });
  await createDelivery(b, new Date('2026-09-11T12:00:00.000Z'));
  await createCollection(
    b,
    '50.00',
    'USD',
    new Date('2026-09-12T12:00:00.000Z'),
  );

  // C — delivered COD, still uncollected.
  const c = await createOrder({
    letter: 'C',
    status: 'DELIVERED',
    subtotal: '40.00',
    totalAmount: '40.00',
    paymentMethod: 'COD',
  });
  await createItem(c, { letter: 'C', unitPrice: '40.00', cost: '10.00' });
  await createDelivery(c, new Date('2026-09-13T12:00:00.000Z'));

  // D — COD collected before delivery; not delivered in the reporting window.
  const d = await createOrder({
    letter: 'D',
    status: 'SHIPPED',
    subtotal: '30.00',
    totalAmount: '30.00',
    paymentMethod: 'COD',
  });
  await createItem(d, { letter: 'D', unitPrice: '30.00', cost: '12.00' });
  await createCollection(
    d,
    '30.00',
    'USD',
    new Date('2026-09-14T12:00:00.000Z'),
  );

  // E — cancelled order with a late PAID callback: orphan cash, not revenue.
  const e = await createOrder({
    letter: 'E',
    status: 'CANCELLED',
    subtotal: '25.00',
    totalAmount: '25.00',
  });
  await createItem(e, { letter: 'E', unitPrice: '25.00', cost: '5.00' });
  await createPayment(e, '25.00', 'USD', new Date('2026-09-15T12:00:00.000Z'));

  // F — unpaid online order: a receivable, never revenue.
  const f = await createOrder({
    letter: 'F',
    status: 'PENDING',
    subtotal: '60.00',
    totalAmount: '60.00',
    createdAt: new Date('2026-09-16T12:00:00.000Z'),
  });
  await createItem(f, { letter: 'F', unitPrice: '60.00', cost: '20.00' });

  // G — duplicate PAID attempts must not double-count cash.
  const g = await createOrder({
    letter: 'G',
    status: 'DELIVERED',
    subtotal: '70.00',
    totalAmount: '70.00',
  });
  await createItem(g, { letter: 'G', unitPrice: '70.00', cost: '30.00' });
  await createPayment(g, '70.00', 'USD', new Date('2026-09-08T12:00:00.000Z'));
  await createPayment(g, '70.00', 'USD', new Date('2026-09-09T12:00:00.000Z'));
  await createDelivery(g, new Date('2026-09-17T12:00:00.000Z'));

  // H — COD collection linked to a PAID payment: counted once as COD cash.
  const h = await createOrder({
    letter: 'H',
    status: 'DELIVERED',
    subtotal: '45.00',
    totalAmount: '45.00',
    paymentMethod: 'COD',
  });
  await createItem(h, { letter: 'H', unitPrice: '45.00', cost: '15.00' });
  const hPaymentId = await createPayment(
    h,
    '45.00',
    'USD',
    new Date('2026-09-18T09:00:00.000Z'),
  );
  await createCollection(
    h,
    '45.00',
    'USD',
    new Date('2026-09-18T10:00:00.000Z'),
    hPaymentId,
  );
  await createDelivery(h, new Date('2026-09-18T12:00:00.000Z'));

  // I — cost currency differs from order currency: excluded from COGS.
  const i = await createOrder({
    letter: 'I',
    status: 'DELIVERED',
    subtotal: '80.00',
    totalAmount: '80.00',
  });
  await createItem(i, {
    letter: 'I',
    unitPrice: '80.00',
    cost: '20.00',
    costCurrency: 'KHR',
  });
  await createPayment(i, '80.00', 'USD', new Date('2026-09-19T09:00:00.000Z'));
  await createDelivery(i, new Date('2026-09-19T12:00:00.000Z'));

  // J — missing cost: unknown, not zero.
  const j = await createOrder({
    letter: 'J',
    status: 'DELIVERED',
    subtotal: '35.00',
    totalAmount: '35.00',
  });
  await createItem(j, { letter: 'J', unitPrice: '35.00', cost: null });
  await createPayment(j, '35.00', 'USD', new Date('2026-09-20T09:00:00.000Z'));
  await createDelivery(j, new Date('2026-09-20T12:00:00.000Z'));

  // K — a second currency; its figures must never be added to USD.
  const k = await createOrder({
    letter: 'K',
    status: 'DELIVERED',
    subtotal: '40000.00',
    totalAmount: '40000.00',
    currency: 'KHR',
  });
  await createItem(k, {
    letter: 'K',
    unitPrice: '40000.00',
    cost: '20000.00',
    currency: 'KHR',
  });
  await createPayment(
    k,
    '40000.00',
    'KHR',
    new Date('2026-09-21T09:00:00.000Z'),
  );
  await createDelivery(k, new Date('2026-09-21T12:00:00.000Z'));

  // L — free shipping only: the discount must not reduce product revenue.
  const l = await createOrder({
    letter: 'L',
    status: 'DELIVERED',
    subtotal: '60.00',
    shippingFee: '10.00',
    discountAmount: '10.00',
    totalAmount: '60.00',
  });
  await createItem(l, { letter: 'L', unitPrice: '60.00', cost: '20.00' });
  await createPayment(l, '60.00', 'USD', new Date('2026-09-22T09:00:00.000Z'));
  await createDelivery(l, new Date('2026-09-22T12:00:00.000Z'));
  await createUsage(l, shippingPromotionId, 'FREE_SHIPPING', '10.00', '60.00');

  // M — 23:59:59 on 30 September in Asia/Phnom_Penh.
  const m = await createOrder({
    letter: 'M',
    status: 'DELIVERED',
    subtotal: '11.00',
    totalAmount: '11.00',
  });
  await createItem(m, { letter: 'M', unitPrice: '11.00', cost: '1.00' });
  await createPayment(m, '11.00', 'USD', new Date('2026-09-30T09:00:00.000Z'));
  await createDelivery(m, new Date('2026-09-30T16:59:59.000Z'));

  // N — 00:00:00 on 1 October in Asia/Phnom_Penh: outside September.
  const n = await createOrder({
    letter: 'N',
    status: 'DELIVERED',
    subtotal: '12.00',
    totalAmount: '12.00',
  });
  await createItem(n, { letter: 'N', unitPrice: '12.00', cost: '1.00' });
  await createPayment(n, '12.00', 'USD', new Date('2026-10-01T09:00:00.000Z'));
  await createDelivery(n, new Date('2026-09-30T17:00:00.000Z'));
}, 120_000);

afterAll(async () => {
  await prisma.codCollection.deleteMany({
    where: { orderId: { in: orderIds } },
  });
  await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.deliveryAssignment.deleteMany({
    where: { orderId: { in: orderIds } },
  });
  await prisma.promotionUsage.deleteMany({
    where: { orderId: { in: orderIds } },
  });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.promotion.deleteMany({ where: { id: { in: promotionIds } } });
  await prisma.productVariant.deleteMany({ where: { productId } });
  await prisma.product.deleteMany({ where: { id: productId } });
  await prisma.category.deleteMany({ where: { id: categoryId } });
  if (codAreaId) {
    await prisma.codArea.deleteMany({ where: { id: codAreaId } });
  }
  if (shippingProviderId) {
    await prisma.shippingProvider.deleteMany({
      where: { id: shippingProviderId },
    });
  }
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

const range = {
  from: '2026-09-01',
  to: '2026-09-30',
  currency: 'USD',
};

describe('FinanceService (integration)', () => {
  it('reports delivered revenue, split discounts and known-cost profit', async () => {
    const result = await service.getOverview(
      query(FinanceQueryDto, { ...range, basis: 'delivered' }),
    );
    const usd = result.byCurrency.find((row) => row.currency === 'USD')!;

    expect(usd.orderCount).toBe(9);
    expect(usd.grossSales).toBe('491.00');
    expect(usd.productDiscounts).toBe('15.00');
    expect(usd.shippingDiscounts).toBe('15.00');
    expect(usd.totalDiscounts).toBe('30.00');
    expect(usd.shippingRevenue).toBe('5.00');
    expect(usd.netProductRevenue).toBe('476.00');
    expect(usd.netRevenue).toBe('481.00');
    expect(usd.averageOrderValue).toBe('53.44');
    expect(usd.cogs).toBe('156.00');
    expect(usd.knownCostNetRevenue).toBe('361.00');
    expect(usd.grossProfit).toBe('205.00');
    expect(usd.grossMargin).toBe('0.5679');
    expect(usd.costCoverage).toBe('0.7658');
    expect(usd.isProfitPartial).toBe(true);
    expect(usd.discountMismatchCount).toBe(0);
  });

  it('recognises booked revenue when cash is evidenced, not when the order was created', async () => {
    const booked = await service.getOverview(
      query(FinanceQueryDto, { ...range, basis: 'booked' }),
    );
    const usd = booked.byCurrency.find((row) => row.currency === 'USD')!;

    expect(usd.orderCount).toBe(9);
    expect(usd.grossSales).toBe('481.00');
    expect(usd.netRevenue).toBe('471.00');
    expect(usd.cogs).toBe('158.00');
    expect(usd.grossProfit).toBe('193.00');

    const deliveredProducts = await service.getProductProfitability(
      query(ProductProfitQueryDto, {
        ...range,
        basis: 'delivered',
        page: 1,
        limit: 100,
        sortBy: 'revenue',
        sortOrder: 'desc',
      }),
    );
    const bookedProducts = await service.getProductProfitability(
      query(ProductProfitQueryDto, {
        ...range,
        basis: 'booked',
        page: 1,
        limit: 100,
        sortBy: 'revenue',
        sortOrder: 'desc',
      }),
    );

    const deliveredSkus = deliveredProducts.items.map((row) => row.variantSku);
    const bookedSkus = bookedProducts.items.map((row) => row.variantSku);

    // C is delivered but uncollected; D is collected but not delivered.
    expect(deliveredSkus).toContain(SKU('C'));
    expect(deliveredSkus).not.toContain(SKU('D'));
    expect(bookedSkus).toContain(SKU('D'));
    expect(bookedSkus).not.toContain(SKU('C'));

    // Cancelled and unpaid orders are in neither set.
    expect(deliveredSkus).not.toContain(SKU('E'));
    expect(bookedSkus).not.toContain(SKU('E'));
    expect(deliveredSkus).not.toContain(SKU('F'));
    expect(bookedSkus).not.toContain(SKU('F'));
  });

  it('counts COD cash once and separates online cash, orphan, deferred and receivable', async () => {
    const result = await service.getCashReconciliation(
      query(CashReconciliationQueryDto, range),
    );
    const usd = result.byCurrency.find((row) => row.currency === 'USD')!;

    // 371 online includes G once (70), not twice, and excludes H's linked PAID.
    expect(usd.onlineCash).toBe('371.00');
    expect(usd.codCash).toBe('125.00');
    expect(usd.cashCollected).toBe('496.00');
    expect(usd.orphanCash).toBe('25.00');
    expect(usd.deferredCash).toBe('30.00');
    expect(usd.codReceivable).toBe('40.00');
    expect(usd.unpaidOnline).toBe('60.00');
    expect(usd.accrualRevenue).toBe('481.00');
    expect(usd.reconciliationVariance).toBe('0.00');
    expect(usd.counts).toEqual({
      onlinePaidOrders: 7,
      codCollectedOrders: 3,
      orphanCashOrders: 1,
      deferredCashOrders: 1,
      codReceivableOrders: 1,
      unpaidOnlineOrders: 1,
      deliveredOrders: 9,
    });
  });

  it('never sums USD and KHR into one figure', async () => {
    const result = await service.getCashReconciliation(
      query(CashReconciliationQueryDto, {
        from: range.from,
        to: range.to,
      }),
    );
    const usd = result.byCurrency.find((row) => row.currency === 'USD')!;
    const khr = result.byCurrency.find((row) => row.currency === 'KHR')!;

    expect(usd.cashCollected).toBe('496.00');
    expect(khr.cashCollected).toBe('40000.00');
    expect(khr.accrualRevenue).toBe('40000.00');
    expect(khr.reconciliationVariance).toBe('0.00');

    const overview = await service.getOverview(
      query(FinanceQueryDto, { from: range.from, to: range.to }),
    );
    expect(
      overview.byCurrency.find((row) => row.currency === 'USD')!.grossSales,
    ).toBe('491.00');
    expect(
      overview.byCurrency.find((row) => row.currency === 'KHR')!.grossSales,
    ).toBe('40000.00');
  });

  it('treats missing and mismatched cost snapshots as unknown, never zero', async () => {
    const result = await service.getProductProfitability(
      query(ProductProfitQueryDto, {
        ...range,
        basis: 'delivered',
        page: 1,
        limit: 100,
        sortBy: 'revenue',
        sortOrder: 'desc',
      }),
    );
    const bySku = new Map(result.items.map((row) => [row.variantSku, row]));

    const comparable = bySku.get(SKU('A'))!;
    expect(comparable.cogs).toBe('60.00');
    expect(comparable.knownCostNetRevenue).toBe('85.00');
    expect(comparable.grossProfit).toBe('25.00');
    expect(comparable.grossMargin).toBe('0.2941');
    expect(comparable.costCoverage).toBe('1.0000');
    expect(comparable.isProfitPartial).toBe(false);

    const mismatch = bySku.get(SKU('I'))!;
    expect(mismatch.cogs).toBeNull();
    expect(mismatch.knownCostNetRevenue).toBe('0.00');
    expect(mismatch.grossProfit).toBeNull();
    expect(mismatch.grossMargin).toBeNull();
    expect(mismatch.costCoverage).toBe('0.0000');
    expect(mismatch.isProfitPartial).toBe(true);

    const missing = bySku.get(SKU('J'))!;
    expect(missing.cogs).toBeNull();
    expect(missing.grossProfit).toBeNull();
    expect(missing.costCoverage).toBe('0.0000');

    const freeShipping = bySku.get(SKU('L'))!;
    expect(freeShipping.productDiscounts).toBe('0.00');
    expect(freeShipping.netRevenue).toBe('60.00');
    expect(freeShipping.grossProfit).toBe('40.00');
  });

  it('paginates product rows in the database without overlap', async () => {
    const page1 = await service.getProductProfitability(
      query(ProductProfitQueryDto, {
        ...range,
        basis: 'delivered',
        page: 1,
        limit: 3,
        sortBy: 'revenue',
        sortOrder: 'desc',
      }),
    );
    const page2 = await service.getProductProfitability(
      query(ProductProfitQueryDto, {
        ...range,
        basis: 'delivered',
        page: 2,
        limit: 3,
        sortBy: 'revenue',
        sortOrder: 'desc',
      }),
    );

    // Nine delivered USD variants: A, B, C, G, H, I, J, L and M. K is KHR.
    expect(page1.pagination.total).toBe(9);
    expect(page1.pagination.totalPages).toBe(3);
    expect(page1.items).toHaveLength(3);
    expect(page2.items).toHaveLength(3);
    expect(
      new Set([...page1.items, ...page2.items].map((row) => row.variantId))
        .size,
    ).toBe(6);
  });

  it('ranks products per currency by known-cost profit', async () => {
    const result = await service.getRankings(
      query(RankingsQueryDto, {
        from: range.from,
        to: range.to,
        basis: 'delivered',
        metric: 'profit',
        limit: 5,
      }),
    );

    const usd = result.items.find((row) => row.currency === 'USD')!;
    const khr = result.items.find((row) => row.currency === 'KHR')!;

    expect(usd.rank).toBe(1);
    expect(usd.grossProfit).toBe('205.00');
    expect(khr.rank).toBe(1);
    expect(khr.grossProfit).toBe('20000.00');
  });

  it('uses Asia/Phnom_Penh day boundaries in the trend series', async () => {
    const september = await service.getRevenueTrend(
      query(RevenueTrendQueryDto, {
        ...range,
        basis: 'delivered',
        granularity: 'day',
      }),
    );
    const septemberUsd = september.series.find(
      (series) => series.currency === 'USD',
    )!;
    expect(
      septemberUsd.buckets.find((bucket) => bucket.period === '2026-10-01'),
    ).toBeUndefined();
    expect(
      septemberUsd.buckets.find((bucket) => bucket.period === '2026-09-30')!
        .netRevenue,
    ).toBe('11.00');

    const boundary = await service.getRevenueTrend(
      query(RevenueTrendQueryDto, {
        from: '2026-09-30',
        to: '2026-10-01',
        currency: 'USD',
        basis: 'delivered',
        granularity: 'day',
      }),
    );
    const boundaryUsd = boundary.series.find(
      (series) => series.currency === 'USD',
    )!;
    expect(boundaryUsd.buckets.map((bucket) => bucket.period)).toEqual([
      '2026-09-30',
      '2026-10-01',
    ]);
    expect(boundaryUsd.buckets[0].netRevenue).toBe('11.00');
    expect(boundaryUsd.buckets[1].netRevenue).toBe('12.00');
  });
});
