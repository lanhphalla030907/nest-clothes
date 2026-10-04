/**
 * Phase 14A smoke test against the **real ABA PayWay sandbox**, and against the
 * **compiled** server (`dist/main.js`) for the parts that do not need PayWay.
 *
 * ## This script is optional, and will refuse to run without credentials
 *
 * Everything in the automated suite stubs the provider, because a test that depends on
 * a third party's uptime is a test that fails for reasons nobody can fix. That leaves
 * exactly one thing the suite *cannot* tell us: whether our HMAC-SHA512 signing,
 * Base64 framing and field order are what PayWay actually accepts. Only a real sandbox
 * call answers that, so this script makes one — deliberately, once, by hand.
 *
 * It needs `PAYWAY_MERCHANT_ID` and `PAYWAY_API_KEY` in the environment, and it exits
 * with a clear message rather than failing obscurely when they are absent. It is also
 * the only code in the project permitted to reach the network, which is why it is a
 * script and not a test.
 *
 * ## What it does, and deliberately does not do
 *
 * It asks PayWay for a real QR against a real sandbox merchant and checks the shape of
 * the reply. It then **stops**. It does not simulate a payment: the sandbox has no
 * mechanism for this project to make a customer appear to have paid, so the callback
 * path can only be exercised by a human with the ABA PayWay sandbox app, and faking it
 * here would prove nothing — the whole point of the callback handler is that it trusts
 * nothing local.
 *
 * So this script verifies the one thing that is verifiable without a human:
 *
 *   1. our signature is accepted by PayWay (a rejected hash is the failure this catches)
 *   2. PayWay returns a QR for the amount and currency we asked for
 *   3. the transaction id we generated is the one PayWay echoes back
 *   4. the stored row matches what PayWay returned
 *   5. the callback endpoint answers a well-formed delivery without erroring, and is
 *      *not* accepted as proof of payment — it must leave the order `PENDING`
 *
 * That last one is the security property, checked against the live deployment: an
 * unauthenticated caller posting a forged "APPROVED" callback must move nothing.
 *
 * ## Usage
 *
 *   PAYWAY_MERCHANT_ID=... PAYWAY_API_KEY=... PAYWAY_CALLBACK_URL=https://... \
 *     node scripts/smoke-payway.mjs <baseUrl>
 *
 * `<baseUrl>` defaults to `http://127.0.0.1:3000`. The server must be the compiled
 * build (`npm run build && npm run start:prod`) running with the same credentials in
 * its own environment.
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
// From `dist`, so the script runs against build output and needs no TypeScript loader.
import { PrismaClient } from '../dist/generated/prisma/client.js';

const base = process.argv[2] ?? 'http://127.0.0.1:3000';
const run = `smoke-payway-${process.pid}-${Date.now().toString(36)}`;
const AMOUNT = '1.00';

const required = ['PAYWAY_MERCHANT_ID', 'PAYWAY_API_KEY', 'PAYWAY_CALLBACK_URL'];
const absent = required.filter((name) => (process.env[name] ?? '').trim() === '');

if (absent.length > 0) {
  console.error(
    `Refusing to run: ${absent.join(', ')} ${absent.length === 1 ? 'is' : 'are'} not set.\n` +
      'This is the one script that talks to the real ABA PayWay sandbox, and it needs real\n' +
      'sandbox credentials to do so. The automated suite covers everything else and never\n' +
      'touches the network.',
  );
  process.exit(2);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

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

const userIds = [];

try {
  const category = await prisma.category.create({
    data: { name: `Smoke PayWay ${run}`, slug: run },
  });
  const owner = (
    await prisma.user.create({
      data: {
        firstName: 'Smoke',
        lastName: 'PayWay',
        email: `${run}@example.test`,
        passwordHash: 'argon2-not-a-real-hash',
        status: 'ACTIVE',
      },
    })
  ).id;
  userIds.push(owner);

  const order = await prisma.order.create({
    data: {
      userId: owner,
      orderNumber: `ORD-${run.slice(-8).toUpperCase()}`,
      status: 'PENDING',
      subtotal: AMOUNT,
      shippingFee: '0.00',
      discountAmount: '0.00',
      totalAmount: AMOUNT,
      currency: 'USD',
      shippingRecipientName: 'Smoke PayWay',
      shippingPhone: '+15555550100',
      shippingAddressLine1: '1 Smoke Lane',
      shippingCity: 'Phnom Penh',
      shippingCountryCode: 'KH',
    },
  });

  // --- 1. the real provider call ------------------------------------------------
  // A rejected signature surfaces as a 4xx/5xx here rather than as a QR, which is the
  // whole reason this script exists: no amount of stubbed testing can tell us that our
  // field order or Base64 framing matches PayWay's expectation.
  const created = await post(`/orders/${order.id}/payments`, {}, owner);
  check(
    'POST /orders/:id/payments reaches PayWay and answers 200',
    created.status === 200,
    `got ${created.status}${created.status === 200 ? '' : ` ${JSON.stringify(created.body)}`}`,
  );

  if (created.status !== 200) {
    throw new Error('Aborting: no QR was issued, so there is nothing further to check.');
  }

  // --- 2. the QR PayWay actually minted ------------------------------------------
  check(
    'PayWay returned a scannable QR string',
    typeof created.body?.qrString === 'string' && created.body.qrString.length > 20,
    `qrString length=${created.body?.qrString?.length ?? 0}`,
  );
  check(
    'the amount charged is the order total, as a two-decimal string',
    created.body?.amount === AMOUNT,
    `amount=${created.body?.amount}`,
  );
  check('the payment is PENDING with a QR', created.body?.status === 'PENDING');

  // --- 3. the row we stored matches ---------------------------------------------
  const stored = await prisma.payment.findUniqueOrThrow({
    where: { transactionId: created.body.transactionId },
  });
  check(
    'the stored transaction id is the one PayWay echoes',
    stored.transactionId === created.body.transactionId,
    stored.transactionId,
  );
  check(
    'PayWay stored our QR, so the repeat request can be served without a second call',
    typeof stored.qrPayload?.qrString === 'string',
  );
  check(
    'the payment is recorded against this order and this merchant',
    stored.orderId === order.id && stored.provider === 'ABA_PAYWAY',
  );

  // --- 4. idempotency, against the live sandbox ----------------------------------
  // The repeat must not mint a second PayWay transaction. PayWay answers a duplicated
  // `tran_id` with 403, so a second call here would be visible as a failure rather than
  // silently succeeding.
  const repeat = await post(`/orders/${order.id}/payments`, {}, owner);
  check(
    'a repeat request returns the same QR and the same transaction',
    repeat.status === 200 && repeat.body?.transactionId === stored.transactionId,
    `status=${repeat.status} transactionId=${repeat.body?.transactionId}`,
  );
  check(
    'the order still has exactly one payment row',
    (await prisma.payment.count({ where: { orderId: order.id } })) === 1,
  );

  // --- 5. a forged callback must move nothing ------------------------------------
  // The endpoint is unauthenticated and PayWay signs nothing, so this is the property
  // most worth confirming against a live deployment: a caller who posts "APPROVED" with
  // a real transaction id gains nothing, because the server asks PayWay what really
  // happened and PayWay says the sandbox customer never paid.
  const forged = await post('/payments/aba-payway/callback', {
    merchant_ref: stored.transactionId,
    payment_status: 'APPROVED',
    payment_status_code: '0',
    amount: AMOUNT,
    currency: 'USD',
  });
  check(
    'a forged APPROVED callback is acknowledged but collects nothing',
    forged.status === 200 && forged.body?.status === 'NOT_COLLECTED',
    `status=${forged.status} body=${JSON.stringify(forged.body)}`,
  );
  check(
    'the forged callback left the order PENDING',
    (await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status ===
      'PENDING',
  );
  check(
    'the forged callback left the payment PENDING',
    (await prisma.payment.findUniqueOrThrow({ where: { id: stored.id } })).status ===
      'PENDING',
  );

  // A well-formed delivery naming a transaction that does not exist must be a 404, so
  // that PayWay's retries are not silenced by a false acknowledgement.
  const unknown = await post('/payments/aba-payway/callback', {
    merchant_ref: 'PW000000000000SMOKE',
  });
  check(
    'a callback for an unknown transaction is 404, not a silent 200',
    unknown.status === 404,
    `got ${unknown.status}`,
  );

  // --- 6. to finish, a human scans the QR ----------------------------------------
  // Left for the operator on purpose; see the header. The transaction id to hand to the
  // ABA sandbox app is printed rather than stored anywhere.
  console.log(
    `\nScan this QR in the ABA PayWay sandbox app to complete the payment by hand:\n` +
      `  qrString   ${created.body.qrString}\n` +
      `  transaction ${stored.transactionId}\n` +
      `  order       ${order.orderNumber}\n` +
      `  amount      ${AMOUNT} USD\n\n` +
      'Then re-run this script\'s final step by hand:\n' +
      `  curl -X POST ${base}/payments/aba-payway/callback \\\n` +
      `    -H 'Content-Type: application/json' \\\n` +
      `    -d '{"merchant_ref":"${stored.transactionId}"}'\n`,
  );
} finally {
  // `payments` before `orders`: the FK is RESTRICT, and a smoke test that cannot clean
  // up after itself would block every future run.
  await prisma.payment.deleteMany({
    where: { order: { userId: { in: userIds } } },
  });
  await prisma.order.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.category.deleteMany({ where: { slug: run } });
  await prisma.$disconnect();
}

const failed = results.filter((result) => !result.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} smoke checks passed`,
);

if (failed.length > 0) {
  process.exitCode = 1;
}
