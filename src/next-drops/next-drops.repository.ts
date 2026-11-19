import { Injectable } from '@nestjs/common';
import { Prisma, type NextDrop } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

export type NextDropWithRelations = Prisma.NextDropGetPayload<{
  include: { collection: true; promotion: true };
}>;

/**
 * The only place in the next-drops feature that talks to the database.
 *
 * Every read and write accepts the caller's `Prisma.TransactionClient` (or
 * defaults to the root client), so a publish that unpublishes the current drop
 * and publishes the target can run inside one transaction.
 */
@Injectable()
export class NextDropRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(
    data: Prisma.NextDropUncheckedCreateInput,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<NextDrop> {
    return client.nextDrop.create({ data });
  }

  findById(
    id: string,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<NextDrop | null> {
    return client.nextDrop.findUnique({ where: { id } });
  }

  findPublished(
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<NextDropWithRelations | null> {
    return client.nextDrop.findFirst({
      where: { isPublished: true },
      include: { collection: true, promotion: true },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    });
  }

  findAll(
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<NextDropWithRelations[]> {
    return client.nextDrop.findMany({
      include: { collection: true, promotion: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  update(
    id: string,
    data: Prisma.NextDropUncheckedUpdateInput,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<NextDrop> {
    return client.nextDrop.update({ where: { id }, data });
  }

  updateMany(
    where: Prisma.NextDropWhereInput,
    data: Prisma.NextDropUpdateInput,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<Prisma.BatchPayload> {
    return client.nextDrop.updateMany({ where, data });
  }

  remove(
    id: string,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<NextDrop> {
    return client.nextDrop.delete({ where: { id } });
  }
}
