import { Module } from '@nestjs/common';
import { JwtAuthModule } from '../auth/jwt/jwt-auth.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { CustomersController } from './customers.controller.js';
import { CustomersRepository } from './customers.repository.js';
import { CustomersService } from './customers.service.js';

/**
 * Administrative customer management.
 *
 * The module owns one controller whose every route is `ADMIN`-guarded, one
 * service that validates query semantics and maps responses, and one
 * repository that aggregates the customer's order history in PostgreSQL. It
 * imports the authentication and Prisma modules only: no auth, registration,
 * checkout, payment or order behaviour is reachable from here, because the
 * feature is read-only by design.
 *
 * `AdminModule` imports this module so the routes are registered alongside
 * every other administrative capability; nothing imports it in the other
 * direction, so no domain feature can reach a customer listing by accident.
 */
@Module({
  imports: [PrismaModule, JwtAuthModule],
  controllers: [CustomersController],
  providers: [CustomersRepository, CustomersService],
  exports: [CustomersService],
})
export class CustomersModule {}
