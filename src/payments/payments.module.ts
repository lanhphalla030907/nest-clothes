import { Module } from '@nestjs/common';
import { OrderModule } from '../orders/order.module.js';
import { TransactionIdGenerator } from './payment-transaction-id.generator.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';
import { PaymentRepository } from './repositories/payment.repository.js';
import { PAYWAY_CONFIG, readPaywayConfig } from './payway/payway.config.js';
import { PaywayService } from './payway/payway.service.js';
import {
  PAYWAY_HTTP_CLIENT,
  type PaywayHttpClient,
} from './payway/payway.types.js';

/**
 * Reads PayWay's configuration once, at module construction.
 *
 * `readPaywayConfig` **never throws** — see `payway.config.ts` for why: the application
 * has to boot without PayWay credentials so that CI, a fresh clone and a cart-only
 * deployment all work, so "unconfigured" is a state to be handled rather than a boot
 * failure. An unresolvable value would still be a genuine bug, so the factory does not
 * swallow that case either; it narrows to the typed union and lets the service refuse
 * with a 503.
 *
 * A `useFactory` rather than a class, for the same reason the Cloudinary module uses
 * one: the validated value is built once and shared, so no consumer can observe a
 * different environment than the one the rest of the integration sees.
 */
const paywayConfigProvider = {
  provide: PAYWAY_CONFIG,
  useFactory: () => readPaywayConfig(),
};

/**
 * The application's HTTP client for PayWay, injected so tests can substitute one.
 *
 * `globalThis.fetch` is read at call time rather than captured at construction so a test
 * that stubs `global.fetch` after boot is still honoured — but nothing in the automated
 * suite relies on that. The tests provide {@link PAYWAY_HTTP_CLIENT} directly, which is
 * why the real PayWay host can never be reached from a test even by accident: there is
 * no code path from a test to this provider.
 */
const paywayHttpClientProvider: {
  provide: symbol;
  useFactory: () => PaywayHttpClient;
} = {
  provide: PAYWAY_HTTP_CLIENT,
  useFactory: (): PaywayHttpClient =>
    ((url, init) => fetch(url, init)) as PaywayHttpClient,
};

/**
 * Owns the payment capability: the PayWay edge, payment attempts, and the two routes.
 *
 * ## Why the HTTP client is a provider here
 *
 * `PAYWAY_HTTP_CLIENT` exists so that *no test can reach the real PayWay sandbox*. It
 * is not a mocking convenience — with the client injected, the automated suite supplies
 * its own, and the only way to reach `checkout-sandbox.payway.com.kh` is to boot the
 * application with real credentials. That is what makes "no automated test touches the
 * network" a structural property rather than a promise in a README.
 *
 * ## Why `OrderModule` is imported
 *
 * Confirming a payment promotes the order to `CONFIRMED`, and that write has to commit
 * in the same transaction as the payment's own `PAID`. Importing `OrdersModule` gets
 * `OrderRepository` — the *data* access needed for the transaction — without reaching
 * for `OrderService`, which would give the payment flow the ability to do things to
 * orders that are none of its business.
 *
 * Deliberately not `@Global`: payments are a domain feature with an inbound webhook,
 * not a process-wide utility, and exporting it would let any future module inject
 * `PaymentRepository` and write payment statuses without going through the verified
 * callback path. Only `PaymentsService` and the repository are exported.
 */
@Module({
  imports: [OrderModule],
  controllers: [PaymentsController],
  providers: [
    paywayConfigProvider,
    paywayHttpClientProvider,
    PaywayService,
    PaymentRepository,
    TransactionIdGenerator,
    PaymentsService,
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
