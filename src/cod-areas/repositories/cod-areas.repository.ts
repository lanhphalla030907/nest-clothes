import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import type { CodArea } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

export interface CreateCodAreaData {
  code: string;
  name: string;
  codEnabled: boolean;
}

export interface UpdateCodAreaData {
  name?: string;
  codEnabled?: boolean;
}

@Injectable()
export class CodAreasRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: CreateCodAreaData): Promise<CodArea> {
    return this.prisma.codArea.create({ data });
  }

  findAll(): Promise<CodArea[]> {
    return this.prisma.codArea.findMany({
      orderBy: [{ name: 'asc' }, { code: 'asc' }],
    });
  }

  findCodEnabled(): Promise<CodArea[]> {
    return this.prisma.codArea.findMany({
      where: { codEnabled: true },
      orderBy: [{ name: 'asc' }, { code: 'asc' }],
    });
  }

  findById(
    id: string,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<CodArea | null> {
    return client.codArea.findUnique({ where: { id } });
  }

  async findForCheckout(
    id: string,
    client: Prisma.TransactionClient,
  ): Promise<CodArea | null> {
    await client.$queryRaw`
      SELECT "id" FROM "cod_areas"
      WHERE "id" = ${id}::uuid
      FOR SHARE
    `;
    return this.findById(id, client);
  }

  findByCode(code: string): Promise<CodArea | null> {
    return this.prisma.codArea.findUnique({ where: { code } });
  }

  update(id: string, data: UpdateCodAreaData): Promise<CodArea> {
    return this.prisma.codArea.update({ where: { id }, data });
  }
}
