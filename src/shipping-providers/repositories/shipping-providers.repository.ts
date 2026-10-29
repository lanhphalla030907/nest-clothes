import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import type { ShippingProvider } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

export interface CreateShippingProviderData {
  code: string;
  name: string;
  description: string | null;
  baseFee: string;
  isActive: boolean;
  supportsCod: boolean;
}

export interface UpdateShippingProviderData {
  code?: string;
  name?: string;
  description?: string | null;
  baseFee?: string;
  isActive?: boolean;
  supportsCod?: boolean;
}

@Injectable()
export class ShippingProvidersRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: CreateShippingProviderData): Promise<ShippingProvider> {
    return this.prisma.shippingProvider.create({ data });
  }

  findAll(): Promise<ShippingProvider[]> {
    return this.prisma.shippingProvider.findMany({
      orderBy: [{ name: 'asc' }, { code: 'asc' }],
    });
  }

  findActive(): Promise<ShippingProvider[]> {
    return this.prisma.shippingProvider.findMany({
      where: { isActive: true },
      orderBy: [{ name: 'asc' }, { code: 'asc' }],
    });
  }

  findById(
    id: string,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<ShippingProvider | null> {
    return client.shippingProvider.findUnique({ where: { id } });
  }

  async findForCheckout(
    id: string,
    client: Prisma.TransactionClient,
  ): Promise<ShippingProvider | null> {
    await client.$queryRaw`
      SELECT "id" FROM "shipping_providers"
      WHERE "id" = ${id}::uuid
      FOR SHARE
    `;
    return this.findById(id, client);
  }

  findByCode(code: string): Promise<ShippingProvider | null> {
    return this.prisma.shippingProvider.findUnique({ where: { code } });
  }

  update(
    id: string,
    data: UpdateShippingProviderData,
  ): Promise<ShippingProvider> {
    return this.prisma.shippingProvider.update({ where: { id }, data });
  }
}
