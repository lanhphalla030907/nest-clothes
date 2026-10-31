import 'dotenv/config';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';

describe('Delivery (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('Manager endpoints', () => {
    it('/delivery/manager/orders (GET) should require authentication', () => {
      return request(app.getHttpServer())
        .get('/delivery/manager/orders')
        .expect(401);
    });

    it('/delivery/manager/assign (POST) should require authentication', () => {
      return request(app.getHttpServer())
        .post('/delivery/manager/assign')
        .send({})
        .expect(401);
    });
  });

  describe('Staff endpoints', () => {
    it('/delivery/staff/assignments (GET) should require authentication', () => {
      return request(app.getHttpServer())
        .get('/delivery/staff/assignments')
        .expect(401);
    });
  });
});
