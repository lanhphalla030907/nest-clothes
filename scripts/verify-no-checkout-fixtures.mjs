/**
 * Fails if any Phase 13 fixture rows survived, in either namespace.
 *
 * The smoke script and the e2e suite both clean up after themselves; this is the
 * check that they actually did, rather than a claim that they do.
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../dist/generated/prisma/client.js';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const prefixes = ['checkout-', 'smoke-'];
/** A prefix match on any of the namespaces these phases name their fixtures with. */
const anyPrefix = (column) => ({
  OR: prefixes.map((prefix) => ({ [column]: { startsWith: prefix } })),
});
const fixtureUser = { user: { is: { OR: prefixes.map((p) => ({ email: { startsWith: p } })) } } };
const fixtureVariant = { variant: { is: { OR: prefixes.map((p) => ({ sku: { startsWith: p } })) } } };

const leftovers = {
  users: await prisma.user.count({ where: anyPrefix('email') }),
  categories: await prisma.category.count({ where: anyPrefix('slug') }),
  products: await prisma.product.count({ where: anyPrefix('slug') }),
  variants: await prisma.productVariant.count({ where: anyPrefix('sku') }),
  inventory: await prisma.inventory.count({ where: fixtureVariant }),
  orders: await prisma.order.count({ where: fixtureUser }),
  orderItems: await prisma.orderItem.count({
    where: { order: { is: fixtureUser } },
  }),
  carts: await prisma.cart.count({ where: fixtureUser }),
  cartItems: await prisma.cartItem.count({
    where: { cart: { is: fixtureUser } },
  }),
  addresses: await prisma.address.count({
    where: { user: { is: { OR: prefixes.map((p) => ({ email: { startsWith: p } })) } } },
  }),
};

await prisma.$disconnect();

const dirty = Object.entries(leftovers).filter(([, count]) => count > 0);

if (dirty.length === 0) {
  console.log('clean: no Phase 13 fixture rows remain', JSON.stringify(leftovers));
} else {
  console.error('LEFTOVER FIXTURES:', JSON.stringify(leftovers));
  process.exitCode = 1;
}
