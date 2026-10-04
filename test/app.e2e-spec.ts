import 'dotenv/config';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';

/**
 * The one E2E test that composes the *whole* application graph.
 *
 * The other E2E specs build a testing module out of just the providers they need, so
 * they cannot catch a wiring mistake in `AppModule` — a module that fails to
 * construct, a provider nobody injects, a route that never gets mapped. This spec
 * exists for that, and for the root route.
 *
 * That is also why it needs `dotenv/config` first: `AppModule` reaches
 * `CloudinaryModule`, whose factory reads `CLOUDINARY_*` from the environment and
 * throws when they are missing. Without the import, every other spec passes while
 * this one fails for a reason that has nothing to do with orders.
 */
describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer()).get('/').expect(200).expect('Hello World!');
  });

  it('mounts the read-only order routes and nothing else', () => {
    // The orders surface is deliberately GET-only: no checkout, no status
    // transition, no cancellation. A future handler added to `OrderController`
    // would show up here as an extra route.
    const server = app.getHttpServer();

    return Promise.all([
      request(server).get('/orders').expect(400),
      request(server).post('/orders').expect(404),
      request(server).delete('/orders/some-id').expect(404),
    ]);
  });

  afterAll(async () => {
    // Optional chaining, so a failure in `beforeAll` is reported once as its own
    // error instead of being masked by a second one thrown from the teardown.
    await app?.close();
  });
});
