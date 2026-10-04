import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module.js';
import { AddressesController } from './addresses.controller.js';
import { AddressesService } from './addresses.service.js';
import { AddressRepository } from './repositories/address.repository.js';

/**
 * Owns the address book: the `addresses` table and the rules about which entry is
 * the user's default.
 *
 * Imports one sibling feature, and only for its repository:
 *
 * - `UsersRepository` — to confirm the identity behind the temporary `X-User-Id`
 *   header is a real user before writing addresses on their behalf.
 *
 * That module already exports its repository for exactly this purpose, so no module
 * reaches into another's tables and the edge runs one way:
 * Addresses -> Users. Nothing imports `AddressesModule` yet.
 *
 * Nothing here imports `CartModule`, `WishlistModule` or `ProductsModule`: an
 * address is a user-owned record with no relationship to any of them, and their
 * behaviour is not reachable from here.
 *
 * ## Nothing is exported yet, and that is deliberate
 *
 * Checkout reads a user's address through `AddressesService`, not through
 * `AddressRepository`, and that is why only the service is exported: copying the
 * "one default per user" or "an address belongs to exactly one user" rule into a
 * checkout that merely needs to look one up would be how those invariants quietly
 * end up enforced in two places — or bypassed altogether. `findOne` accepts a
 * transaction client so the ownership check and the order write share a view.
 *
 * `PrismaService` arrives without an explicit import because `PrismaModule` is
 * `@Global`.
 */
@Module({
  imports: [UsersModule],
  controllers: [AddressesController],
  providers: [AddressesService, AddressRepository],
  exports: [AddressesService],
})
export class AddressesModule {}
