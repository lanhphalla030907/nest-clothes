import { Module } from '@nestjs/common';
import { JwtAuthModule } from '../auth/jwt/jwt-auth.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { FinanceController } from './finance.controller.js';
import { FinanceRepository } from './finance.repository.js';
import { FinanceService } from './finance.service.js';

/**
 * Administrative finance and profit reporting.
 *
 * The module owns one controller whose every route is `ADMIN`-guarded, one
 * service that resolves reporting windows and serialises exact decimals, and one
 * repository that performs the aggregation in PostgreSQL. It imports the
 * authentication and Prisma modules only; no order, payment, promotion or
 * delivery behaviour is reachable from here.
 */
@Module({
  imports: [PrismaModule, JwtAuthModule],
  controllers: [FinanceController],
  providers: [FinanceRepository, FinanceService],
  exports: [FinanceService],
})
export class FinanceModule {}
