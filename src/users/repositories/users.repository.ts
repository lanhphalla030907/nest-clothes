import { Injectable } from '@nestjs/common';
import { ACTIVE_USER_STATUS } from '../../common/constants/user-status.constants.js';
import { Prisma, type User } from '../../generated/prisma/client.js';
import { Role } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';

/** A client bound to an interactive transaction, accepted by every write below. */
export type UserTransactionClient = Prisma.TransactionClient;

/**
 * The only place in the users feature that talks to the database.
 *
 * It owns User persistence and nothing else: no normalisation, no hashing, no
 * exception mapping, no DTO mapping. That keeps the SQL surface of the User
 * aggregate in one auditable file and lets services express *what* they need
 * without knowing the query shape.
 *
 * The methods below are the complete set required by the application today.
 * It is deliberately not generalised into a base class or generic CRUD helper —
 * each method states exactly which columns and filters it touches.
 */
@Injectable()
export class UsersRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Returns the user owning `email`, or `null` when no such user exists. */
  findByEmail(
    email: string,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<User | null> {
    return client.user.findUnique({ where: { email } });
  }

  /**
   * Returns the user with `id`, or `null` when no such user exists.
   *
   * Exists for features that are scoped to a user supplied by the request
   * (currently the cart) and therefore have to confirm the owner is real before
   * writing anything on their behalf.
   */
  findById(
    id: string,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<User | null> {
    return client.user.findUnique({ where: { id } });
  }

  /** Persists a new user and returns the stored entity. */
  create(
    data: Prisma.UserCreateInput,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<User> {
    return client.user.create({ data });
  }

  /**
   * Writes `lastLoginAt` for `userId` and nothing else, so this operation can
   * never accidentally overwrite unrelated user columns.
   */
  updateLastLoginAt(
    userId: string,
    lastLoginAt: Date,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<User> {
    return client.user.update({
      where: { id: userId },
      data: { lastLoginAt },
    });
  }

  /**
   * Writes `emailVerifiedAt` for `userId` and nothing else.
   */
  updateEmailVerifiedAt(
    userId: string,
    emailVerifiedAt: Date,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<User> {
    return client.user.update({
      where: { id: userId },
      data: { emailVerifiedAt },
    });
  }

  /**
   * Sets a new local password credential.
   *
   * `passwordChangedAt` is what makes existing access tokens stop working after
   * a reset: `JwtAuthGuard` compares the token's issue time with it. A reset
   * delivered to the account's email also proves control of that address, so an
   * unverified address is marked verified in the same write.
   */
  updatePassword(
    userId: string,
    data: {
      passwordHash: string;
      passwordChangedAt: Date;
      emailVerifiedAt: Date | null;
    },
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<User> {
    return client.user.update({
      where: { id: userId },
      data,
    });
  }

  /**
   * Runs `work` in one interactive transaction. Role changes read before writing,
   * so the read, the update and the audit insert must never be observed apart.
   */
  runInTransaction<T>(
    work: (tx: UserTransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(work);
  }

  /** Returns every user for the admin list, in a stable name order. */
  findAll(
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<User[]> {
    return client.user.findMany({
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    });
  }

  /** Returns one bounded admin page and its matching total. */
  async findAdminPage(
    filters: {
      page: number;
      limit: number;
      role?: Role;
      status?: string;
      search?: string;
    },
  ): Promise<{ items: User[]; total: number }> {
    const where: Prisma.UserWhereInput = {
      ...(filters.role === undefined ? {} : { role: filters.role }),
      ...(filters.status === undefined ? {} : { status: filters.status }),
      ...(filters.search === undefined || filters.search === ''
        ? {}
        : {
            OR: [
              { firstName: { contains: filters.search, mode: 'insensitive' } },
              { lastName: { contains: filters.search, mode: 'insensitive' } },
              { email: { contains: filters.search, mode: 'insensitive' } },
            ],
          }),
    };
    const skip = (filters.page - 1) * filters.limit;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
        skip,
        take: filters.limit,
      }),
      this.prisma.user.count({ where }),
    ]);
    return { items, total };
  }

  /** Counts active administrators — the guard against demoting the last one. */
  countActiveAdmins(
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<number> {
    return client.user.count({
      where: { role: Role.ADMIN, status: ACTIVE_USER_STATUS },
    });
  }

  /** Writes only the role column, never any other user field. */
  updateRole(
    userId: string,
    role: Role,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<User> {
    return client.user.update({
      where: { id: userId },
      data: { role },
    });
  }

  /** Writes only account status, never a role or related user data. */
  updateStatus(
    userId: string,
    status: string,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<User> {
    return client.user.update({ where: { id: userId }, data: { status } });
  }

  /** Appends the immutable audit record for a completed role change. */
  recordRoleChange(
    data: Prisma.UserRoleChangeUncheckedCreateInput,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<unknown> {
    return client.userRoleChange.create({ data });
  }
}
