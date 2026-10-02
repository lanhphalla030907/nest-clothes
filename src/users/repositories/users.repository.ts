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
  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  /** Persists a new user and returns the stored entity. */
  create(data: Prisma.UserCreateInput): Promise<User> {
    return this.prisma.user.create({ data });
  }

  /**
   * Writes `lastLoginAt` for `userId` and nothing else, so this operation can
   * never accidentally overwrite unrelated user columns.
   */
  updateLastLoginAt(userId: string, lastLoginAt: Date): Promise<User> {
    return this.prisma.user.update({
      where: { id: userId },
      data: { lastLoginAt },
    });
  }
}
