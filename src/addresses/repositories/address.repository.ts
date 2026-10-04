import { Injectable } from '@nestjs/common';
import type { Address, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

export type { Address };

/**
 * A Prisma client bound to an interactive transaction.
 *
 * Repository methods accept one so the service can run a read followed by writes
 * against the *same* connection and transaction. That is what makes "look at the
 * current default, then demote it and promote another" atomic instead of racing a
 * second writer between the statements.
 */
export type AddressTransactionClient = Prisma.TransactionClient;

/**
 * The exact columns a create is allowed to write.
 *
 * `id`, `createdAt` and `updatedAt` are absent because they are database-owned and
 * must never be reachable from a request payload. `userId` is present because the
 * address cannot exist without an owner, and the service fills it in from the
 * request identity — never from the body.
 */
export interface CreateAddressData {
  userId: string;
  label: string;
  recipientName: string;
  phone: string;
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
  stateProvince?: string | null;
  postalCode?: string | null;
  countryCode: string;
  isDefault: boolean;
}

/**
 * The exact columns an update is allowed to write.
 *
 * Every field is optional, and only the keys actually present are written, so an
 * omitted field leaves its column alone rather than overwriting it with `undefined`.
 *
 * **`isDefault` is absent on purpose.** It is not a column this method may touch.
 * The single-default invariant is maintained by exactly two methods,
 * {@link AddressRepository.demoteDefaults} and
 * {@link AddressRepository.promoteByIdAndUserId}, and keeping the flag out of the
 * general update is what makes it impossible for an ordinary field edit to clear or
 * duplicate a default.
 */
export type UpdateAddressData = Partial<
  Omit<CreateAddressData, 'userId' | 'isDefault'>
>;

/**
 * Ordering for an address book: the default first, then oldest to newest.
 *
 * `isDefault desc` puts the default at the top of a checkout's address picker
 * without the client sorting anything, and `id` is the tiebreak so two identical
 * requests cannot return the same rows in different orders.
 */
const ADDRESS_BOOK_ORDER_BY = [
  { isDefault: 'desc' },
  { createdAt: 'asc' },
  { id: 'asc' },
] satisfies Prisma.AddressOrderByWithRelationInput[];

/**
 * Ordering for choosing a new default: the oldest surviving address.
 *
 * Oldest rather than newest so that deleting a default promotes the *longest
 * standing* remaining address — the one least likely to be a temporary entry — and
 * so the choice is deterministic rather than dependent on which row the planner
 * happened to return first.
 */
const DEFAULT_SUCCESSOR_ORDER_BY = [
  { createdAt: 'asc' },
  { id: 'asc' },
] satisfies Prisma.AddressOrderByWithRelationInput[];

/**
 * The only place in the addresses feature that talks to the database.
 *
 * It owns the `addresses` table and nothing else: no default-address reasoning, no
 * exception mapping, no DTO mapping, no HTTP status decisions. The `users` row is
 * reached through `UsersRepository`, never through a join here.
 *
 * ## The single-default invariant
 *
 * "A user has at most one default address" is enforced by the database — a partial
 * unique index on `(user_id) WHERE is_default = true` — not by this code. The
 * service sequences the statements that maintain it; the index is what makes that
 * sequencing safe rather than merely hopeful, by rejecting a second default instead
 * of storing it.
 *
 * ## Transactions
 *
 * {@link runInTransaction} is the primitive every write that touches `is_default`
 * goes through. Demoting the incumbent and promoting its successor are two
 * statements, and running them in one transaction is what guarantees a reader never
 * observes a user in the state "has addresses but no default": at `READ COMMITTED`
 * an outside reader sees the pre-transaction state until the commit, so the swap is
 * atomic from every other connection's point of view.
 *
 * Ownership is part of the `WHERE` clause of every single-address write rather than
 * a check the service performs beforehand, so an address that moves out from under
 * the check is rejected by the database (as `P2025`) instead of being written.
 */
@Injectable()
export class AddressRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Runs `work` in a single interactive transaction and hands it a client bound to
   * that transaction. Use it for every write that reads before it writes.
   */
  runInTransaction<T>(
    work: (tx: AddressTransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(work);
  }

  /**
   * Returns every address belonging to `userId`, default first.
   *
   * Returns an empty array — never `null` — for a user with no addresses: "no
   * addresses" is a perfectly good address book, not a missing resource, and the
   * API answers `200 []`.
   */
  findAllByUserId(
    userId: string,
    client: AddressTransactionClient = this.prisma,
  ): Promise<Address[]> {
    return client.address.findMany({
      where: { userId },
      orderBy: ADDRESS_BOOK_ORDER_BY,
    });
  }

  /**
   * Returns the address `addressId` only when it belongs to `userId`, else `null`.
   *
   * Filtering by owner in the query — rather than fetching by id and comparing in
   * the service — means "no such address" and "that address belongs to somebody
   * else" are indistinguishable, which is what lets both answer the same 404
   * without letting one user's address book be probed through another's ids.
   */
  findByIdAndUserId(
    addressId: string,
    userId: string,
    client: AddressTransactionClient = this.prisma,
  ): Promise<Address | null> {
    return client.address.findFirst({ where: { id: addressId, userId } });
  }

  /**
   * Counts the addresses belonging to `userId`.
   *
   * A `count` rather than loading the rows: the caller only needs to know whether
   * this is the user's first address, and `addresses_user_id_idx` serves the filter
   * directly.
   */
  countByUserId(
    userId: string,
    client: AddressTransactionClient = this.prisma,
  ): Promise<number> {
    return client.address.count({ where: { userId } });
  }

  /**
   * Returns the oldest address that is not the default, or `null` when the user has
   * none — the successor to promote when the current default is deleted.
   *
   * The `isDefault: false` filter is what makes this safe to call immediately after
   * the default row has been deleted inside the same transaction.
   */
  findDefaultSuccessor(
    userId: string,
    client: AddressTransactionClient = this.prisma,
  ): Promise<Address | null> {
    return client.address.findFirst({
      where: { userId, isDefault: false },
      orderBy: DEFAULT_SUCCESSOR_ORDER_BY,
    });
  }

  /**
   * Inserts a new address and returns it.
   *
   * Rejects with `P2002` when the partial unique index is violated, which happens
   * only when `isDefault` is true and a concurrent request became the default first.
   * The service treats that rejection as a lost race and retries the whole
   * read-modify-write rather than surfacing an error.
   */
  create(
    data: CreateAddressData,
    client: AddressTransactionClient = this.prisma,
  ): Promise<Address> {
    return client.address.create({ data });
  }

  /**
   * Writes the editable columns of `addressId` when it belongs to `userId`.
   *
   * Rejects with `P2025` when the address is absent or not the caller's, which the
   * service maps to 404. `isDefault` cannot be written through here — see
   * {@link UpdateAddressData}.
   */
  updateByIdAndUserId(
    addressId: string,
    userId: string,
    data: UpdateAddressData,
    client: AddressTransactionClient = this.prisma,
  ): Promise<Address> {
    return client.address.update({ where: { id: addressId, userId }, data });
  }

  /**
   * Removes `addressId` when it belongs to `userId`.
   *
   * Rejects with `P2025` when it is absent or not the caller's, which the service
   * maps to 404. An address has no dependants — orders will snapshot rather than
   * reference — so there is no restrict case to handle here and no cascade beyond
   * the one from the user.
   */
  deleteByIdAndUserId(
    addressId: string,
    userId: string,
    client: AddressTransactionClient = this.prisma,
  ): Promise<Address> {
    return client.address.delete({ where: { id: addressId, userId } });
  }

  /**
   * Clears `is_default` on every default address of `userId` and returns how many
   * rows were changed.
   *
   * `exceptAddressId` spares one address from being demoted. That is what makes
   * re-promoting an address that is *already* the default a no-op instead of a
   * demote-then-promote pair that briefly leaves the user with no default at all
   * inside the transaction.
   *
   * Written as `updateMany` so the demotion is one statement regardless of how many
   * rows are affected — which, given the partial unique index, is never more than
   * one.
   */
  demoteDefaults(
    userId: string,
    exceptAddressId: string | null,
    client: AddressTransactionClient = this.prisma,
  ): Promise<number> {
    return client.address
      .updateMany({
        where: {
          userId,
          isDefault: true,
          ...(exceptAddressId === null ? {} : { id: { not: exceptAddressId } }),
        },
        data: { isDefault: false },
      })
      .then((result) => result.count);
  }

  /**
   * Makes `addressId` the default for `userId` and returns the updated row.
   *
   * The caller must have demoted the incumbent in the same transaction first;
   * otherwise the partial unique index rejects this with `P2002`, which is exactly
   * the intended behaviour — two requests cannot both promote a default.
   *
   * Rejects with `P2025` when the address is absent or not the caller's.
   */
  promoteByIdAndUserId(
    addressId: string,
    userId: string,
    client: AddressTransactionClient = this.prisma,
  ): Promise<Address> {
    return client.address.update({
      where: { id: addressId, userId },
      data: { isDefault: true },
    });
  }
}
