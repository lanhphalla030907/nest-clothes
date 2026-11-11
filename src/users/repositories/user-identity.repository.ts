import { Injectable } from '@nestjs/common';
import { Prisma, type User, type UserIdentity } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

export type UserIdentityWithUser = UserIdentity & { user: User };

@Injectable()
export class UserIdentityRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Finds an external federated identity by provider and unique subject identifier,
   * including the associated user record.
   */
  findByProviderSubject(
    provider: string,
    providerSubject: string,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<UserIdentityWithUser | null> {
    return client.userIdentity.findUnique({
      where: {
        provider_providerSubject: {
          provider,
          providerSubject,
        },
      },
      include: {
        user: true,
      },
    });
  }

  /**
   * Returns safe, minimal provider information for an authenticated user.
   * Never exposes raw subject identifiers to clients.
   */
  findIdentitiesByUserId(
    userId: string,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<Array<Pick<UserIdentity, 'id' | 'provider' | 'createdAt'>>> {
    return client.userIdentity.findMany({
      where: { userId },
      select: {
        id: true,
        provider: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Creates a new user identity record linking a user to an external provider.
   */
  create(
    data: Prisma.UserIdentityUncheckedCreateInput,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<UserIdentity> {
    return client.userIdentity.create({ data });
  }

  /**
   * Checks whether a provider identity already exists without returning user details.
   */
  async exists(
    provider: string,
    providerSubject: string,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<boolean> {
    const found = await client.userIdentity.findUnique({
      where: {
        provider_providerSubject: {
          provider,
          providerSubject,
        },
      },
      select: { id: true },
    });
    return found !== null;
  }
}
