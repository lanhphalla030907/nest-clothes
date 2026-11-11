import { Injectable } from '@nestjs/common';
import { Prisma, type User } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

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
}
