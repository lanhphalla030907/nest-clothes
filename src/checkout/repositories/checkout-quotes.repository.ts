import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

export type CheckoutQuoteTransactionClient = Prisma.TransactionClient;

@Injectable()
export class CheckoutQuotesRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(
    data: Prisma.CheckoutQuoteUncheckedCreateInput,
    client: CheckoutQuoteTransactionClient = this.prisma,
  ) {
    return client.checkoutQuote.create({ data });
  }

  findForOwner(
    id: string,
    userId: string,
    client: CheckoutQuoteTransactionClient = this.prisma,
  ) {
    return client.checkoutQuote.findFirst({ where: { id, userId } });
  }

  findByIdempotencyKey(userId: string, idempotencyKey: string) {
    return this.prisma.checkoutQuote.findFirst({
      where: { userId, idempotencyKey },
    });
  }

  consume(
    id: string,
    userId: string,
    idempotencyKey: string,
    orderId: string,
    client: CheckoutQuoteTransactionClient,
  ) {
    return client.checkoutQuote.updateMany({
      where: {
        id,
        userId,
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: {
        consumedAt: new Date(),
        idempotencyKey,
        orderId,
      },
    });
  }
}
