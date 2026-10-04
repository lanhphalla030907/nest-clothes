/**
 * Phase 13 smoke test against the **compiled** server (`dist/main.js`).
 *
 * The unit and E2E suites both run TypeScript through vitest. This runs the actual
 * build output as a separate process over HTTP, which is the only way to catch
 * something that is true of the source but not of the artefact: a file missing from
 * the build, a decorator the compiler dropped, a module that never got imported.
 *
 * It walks the four behaviours that matter and then deletes everything it created:
 *
 *   1. a real checkout reserves stock, writes an order and empties the cart
 *   2. ordering more than is available is 409 and leaves no trace
 *   3. another user's address is 404, not 403
 *   4. an empty cart is 400
 *
 * Usage: node scripts/smoke-checkout.mjs <baseUrl>
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
// From `dist`, so the whole smoke test runs against build output and needs no
// TypeScript loader.
import { PrismaClient } from '../dist/generated/prisma/client.js';

const base = process.argv[2] ?? 'http://127.0.0.1:3000';
const run = `smoke-${process.pid}-${Date.now().toString(36)}`;
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const userIds = [];

const post = async (path, body, user) => {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      ...(user === undefined ? {} : { 'X-User-Id': user }),
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();

  return { status: res.status, body: text === '' ? undefined : JSON.parse(text) };
};

try {
  const category = await prisma.category.create({
    data: { name: `Smoke ${run}`, slug: `smoke-${run}` },
  });
  const product = await prisma.product.create({
    data: {
      categoryId: category.id,
      name: 'Smoke Peacoat',
      slug: `smoke-${run}-product`,
      basePrice: '129.00',
      status: 'ACTIVE',
    },
  });
  const variant = await prisma.productVariant.create({
    data: { productId: product.id, sku: `smoke-${run}-SKU`, price: '129.00' },
  });
  await prisma.inventory.create({
    data: { variantId: variant.id, quantity: 5, reservedQuantity: 0 },
  });

  const makeUser = async (name) => {
    const user = await prisma.user.create({
      data: {
        firstName: 'Smoke',
        lastName: 'Tester',
        email: `${run}-${name}@example.test`,
        passwordHash: 'argon2-not-a-real-hash',
        status: 'ACTIVE',
      },
    });
    userIds.push(user.id);

    return user.id;
  };
  const makeAddress = async (user, name) =>
    (
      await prisma.address.create({
        data: {
          userId: user,
          label: 'Home',
          recipientName: `Recipient ${name}`,
          phone: '+15555550100',
          addressLine1: '18 Mill Lane',
          city: 'Bristol',
          postalCode: 'BS1 4TR',
          countryCode: 'GB',
        },
      })
    ).id;

  const owner = await makeUser('owner');
  const stranger = await makeUser('stranger');
  const ownerAddress = await makeAddress(owner, 'owner');
  const strangerAddress = await makeAddress(stranger, 'stranger');

  // --- 1. the happy path ------------------------------------------------------
  const cart = await prisma.cart.create({ data: { userId: owner } });
  await prisma.cartItem.create({
    data: { cartId: cart.id, variantId: variant.id, quantity: 2 },
  });

  const ok = await post('/checkout', { addressId: ownerAddress }, owner);
  check('POST /checkout answers 201', ok.status === 201, `got ${ok.status}`);
  check(
    'the response is the order, with money as two-decimal strings',
    typeof ok.body?.orderNumber === 'string' &&
      ok.body?.status === 'PENDING' &&
      ok.body?.subtotal === '258.00' &&
      ok.body?.totalAmount === '258.00' &&
      Array.isArray(ok.body?.items) &&
      ok.body.items.length === 1,
    JSON.stringify({
      orderNumber: ok.body?.orderNumber,
      status: ok.body?.status,
      total: ok.body?.totalAmount,
    }),
  );
  check(
    'the response leaks no password hash and no nested user',
    !JSON.stringify(ok.body).includes('argon2') &&
      !JSON.stringify(ok.body).includes('passwordHash') &&
      ok.body?.user === undefined,
  );

  const stock = await prisma.inventory.findUniqueOrThrow({
    where: { variantId: variant.id },
  });
  check(
    'stock is reserved, not deducted',
    stock.quantity === 5 && stock.reservedQuantity === 2,
    `quantity=${stock.quantity} reserved=${stock.reservedQuantity}`,
  );
  const items = await prisma.cartItem.count({ where: { cartId: cart.id } });
  check('the cart is emptied but kept', items === 0);

  const order = await prisma.order.findUniqueOrThrow({
    where: { id: ok.body.id },
    include: { items: true },
  });
  check(
    'the order snapshots the address, the name and the sku',
    order.shippingRecipientName === 'Recipient owner' &&
      order.shippingAddressLine1 === '18 Mill Lane' &&
      order.shippingCountryCode === 'GB' &&
      order.items[0].productName === 'Smoke Peacoat' &&
      order.items[0].sku === `smoke-${run}-SKU`,
    JSON.stringify({
      recipient: order.shippingRecipientName,
      line1: order.shippingAddressLine1,
      productName: order.items[0].productName,
    }),
  );

  // --- 2. more than is available ----------------------------------------------
  const greedy = await prisma.cart.create({ data: { userId: stranger } });
  await prisma.cartItem.create({
    data: { cartId: greedy.id, variantId: variant.id, quantity: 4 },
  });
  const ordersBefore = await prisma.order.count();
  const conflict = await post('/checkout', { addressId: strangerAddress }, stranger);
  check('insufficient stock is 409', conflict.status === 409, `got ${conflict.status}`);
  check(
    'the failed checkout wrote no order',
    (await prisma.order.count()) === ordersBefore,
  );
  const afterConflict = await prisma.inventory.findUniqueOrThrow({
    where: { variantId: variant.id },
  });
  check(
    'the failed checkout reserved nothing and left the cart intact',
    afterConflict.reservedQuantity === 2 &&
      (await prisma.cartItem.count({ where: { cartId: greedy.id } })) === 1,
  );

  // --- 3. someone else's address ---------------------------------------------
  const stolen = await post('/checkout', { addressId: ownerAddress }, stranger);
  check(
    "another user's address is 404, not 403",
    stolen.status === 404,
    `got ${stolen.status}`,
  );

  // --- 4. an empty cart -------------------------------------------------------
  // The basket still holds the line from step 2 (the 409 left it untouched, which
  // is the point of that check), so empty it first to isolate this case.
  await prisma.cartItem.deleteMany({ where: { cartId: greedy.id } });
  const empty = await post('/checkout', { addressId: strangerAddress }, stranger);
  check('an empty cart is 400', empty.status === 400, `got ${empty.status}`);
  check(
    'the empty-cart error names the problem',
    /empty cart/i.test(empty.body?.message ?? ''),
    empty.body?.message,
  );

  // --- 5. the identity header is still required ------------------------------
  const anonymous = await post('/checkout', { addressId: ownerAddress });
  check(
    'a request with no identity is rejected',
    anonymous.status === 400,
    `got ${anonymous.status}`,
  );

  // --- 6. concurrent checkouts against the same stock -------------------------
  // The reason the reservation is a single guarded UPDATE rather than a read
  // followed by a write. Four buyers each want 3 of the 5 units still unreserved,
  // all four requests in flight together: at most one can win, and whatever the
  // interleaving, `reserved_quantity` must never pass `quantity`.
  await prisma.inventory.update({
    where: { variantId: variant.id },
    data: { quantity: 5, reservedQuantity: 0 },
  });

  const racers = [];
  for (let index = 0; index < 4; index += 1) {
    const racer = await makeUser(`racer-${index}`);
    const address = await makeAddress(racer, `racer-${index}`);
    const racerCart = await prisma.cart.create({ data: { userId: racer } });
    await prisma.cartItem.create({
      data: { cartId: racerCart.id, variantId: variant.id, quantity: 3 },
    });
    racers.push({ racer, address });
  }

  const raced = await Promise.all(
    racers.map(({ racer, address }) => post('/checkout', { addressId: address }, racer)),
  );
  const created = raced.filter((res) => res.status === 201).length;
  const conflicted = raced.filter((res) => res.status === 409).length;

  const afterRace = await prisma.inventory.findUniqueOrThrow({
    where: { variantId: variant.id },
  });
  check(
    'concurrent checkouts never oversell',
    afterRace.reservedQuantity <= afterRace.quantity,
    `quantity=${afterRace.quantity} reserved=${afterRace.reservedQuantity}`,
  );
  check(
    'only the buyers the stock can satisfy are served',
    created === 1 && conflicted === 3,
    `created=${created} conflict=${conflicted} of ${raced.length}`,
  );
  check(
    'the held stock matches the orders that were actually written',
    afterRace.reservedQuantity === 3 &&
      (await prisma.order.count({ where: { userId: { in: racers.map((r) => r.racer) } } })) ===
        created,
    `reserved=${afterRace.reservedQuantity} created=${created}`,
  );
  // Every refused buyer must still be holding their untouched basket, and the one
  // served buyer must not be.
  const servedIds = racers
    .filter((_, index) => raced[index].status === 201)
    .map(({ racer }) => racer);
  const refusedIds = racers
    .filter((_, index) => raced[index].status !== 201)
    .map(({ racer }) => racer);
  const cartLines = await prisma.cartItem.groupBy({
    by: ['cartId'],
    where: { cart: { userId: { in: servedIds } } },
    _count: { cartId: true },
  });
  check(
    'the served buyer is emptied and every refused buyer keeps their basket',
    cartLines.length === 0 &&
      (await prisma.cartItem.count({
        where: { cart: { userId: { in: refusedIds } }, quantity: 3 },
      })) === refusedIds.length,
    `served=${servedIds.length} refused=${refusedIds.length} servedLines=${cartLines.length}`,
  );
} finally {
  await prisma.orderItem.deleteMany({
    where: { order: { userId: { in: userIds } } },
  });
  await prisma.order.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.cartItem.deleteMany({
    where: { cart: { userId: { in: userIds } } },
  });
  await prisma.cart.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.inventory.deleteMany({
    where: { variant: { sku: { startsWith: `smoke-` } } },
  });
  await prisma.address.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.productVariant.deleteMany({
    where: { sku: { startsWith: `smoke-` } },
  });
  await prisma.product.deleteMany({ where: { slug: { startsWith: `smoke-` } } });
  await prisma.category.deleteMany({ where: { slug: { startsWith: `smoke-` } } });
  await prisma.$disconnect();
}

const failed = results.filter((result) => !result.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} smoke checks passed`,
);

if (failed.length > 0) {
  process.exitCode = 1;
}
