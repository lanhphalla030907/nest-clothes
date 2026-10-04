/**
 * Removes rows left behind by a checkout e2e run whose teardown could not finish.
 *
 * Scoped strictly to the `checkout-` prefix this suite namespaces its fixtures
 * with, so it can never touch another suite's data.
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';

// The same driver adapter the application uses, so this talks to the same database.
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

const users = await prisma.user.findMany({
  where: { email: { startsWith: 'checkout-' } },
  select: { id: true },
});
const ids = users.map((user) => user.id);

if (ids.length === 0) {
  console.log('no leftover checkout fixtures');
} else {
  const orderItems = await prisma.orderItem.deleteMany({
    where: { order: { userId: { in: ids } } },
  });
  const orders = await prisma.order.deleteMany({
    where: { userId: { in: ids } },
  });
  const cartItems = await prisma.cartItem.deleteMany({
    where: { cart: { userId: { in: ids } } },
  });
  const carts = await prisma.cart.deleteMany({ where: { userId: { in: ids } } });
  const inventory = await prisma.inventory.deleteMany({
    where: { variant: { sku: { startsWith: 'checkout-' } } },
  });
  const wishlistItems = await prisma.wishlistItem.deleteMany({
    where: { wishlist: { userId: { in: ids } } },
  });
  const wishlists = await prisma.wishlist.deleteMany({
    where: { userId: { in: ids } },
  });
  const addresses = await prisma.address.deleteMany({
    where: { userId: { in: ids } },
  });
  const removedUsers = await prisma.user.deleteMany({
    where: { id: { in: ids } },
  });
  const variants = await prisma.productVariant.deleteMany({
    where: { sku: { startsWith: 'checkout-' } },
  });
  const products = await prisma.product.deleteMany({
    where: { slug: { startsWith: 'checkout-' } },
  });
  const categories = await prisma.category.deleteMany({
    where: { slug: { startsWith: 'checkout-' } },
  });

  console.log(
    {
      users: removedUsers.count,
      addresses: addresses.count,
      orders: orders.count,
      orderItems: orderItems.count,
      carts: carts.count,
      cartItems: cartItems.count,
      inventory: inventory.count,
      wishlists: wishlists.count,
      wishlistItems: wishlistItems.count,
      variants: variants.count,
      products: products.count,
      categories: categories.count,
    },
    'leftover checkout fixtures removed',
  );
}

await prisma.$disconnect();
