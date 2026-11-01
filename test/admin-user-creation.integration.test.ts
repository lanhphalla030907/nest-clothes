import 'dotenv/config';
import {
  HttpStatus,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module.js';
import { Role } from '../src/generated/prisma/enums.js';
import { PasswordService } from '../src/auth/password/password.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import {
  bearerHeaders,
  tokenIssuerFor,
  type IssueToken,
} from './support/e2e-auth.js';

describe('Admin delivery staff account creation (PostgreSQL)', () => {
  const run = randomUUID().slice(0, 8);

  let app: INestApplication;
  let prisma: PrismaService;
  let passwordService: PasswordService;
  let base: string;
  let issueToken: IssueToken;
  let adminId: string;
  let customerId: string;

  const createdUserIds: string[] = [];

  const api = async (
    method: string,
    path: string,
    options: { user?: string; body?: unknown } = {},
  ) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(options.body === undefined
          ? {}
          : { 'Content-Type': 'application/json' }),
        ...(options.user === undefined
          ? {}
          : bearerHeaders(issueToken, false)(options.user)),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();

    return {
      status: response.status,
      text,
      body: text.length === 0 ? undefined : JSON.parse(text),
    };
  };

  const createBaseUser = async (label: string, role: Role) => {
    const id = randomUUID();
    await prisma.user.create({
      data: {
        id,
        firstName: 'Admin user test',
        lastName: `${label}-${run}`,
        email: `${label}-${run}-${id.slice(0, 8)}@example.test`,
        passwordHash: 'not-used-by-this-suite',
        status: 'ACTIVE',
        role,
      },
    });
    createdUserIds.push(id);
    return id;
  };

  const validInput = (email = `staff-${run}@example.test`) => ({
    firstName: 'Ada',
    lastName: 'Courier',
    email,
    password: 'a-secure-password',
    phone: '+15555550100',
  });

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        'DATABASE_URL is not set — Admin user integration tests require PostgreSQL',
      );
    }

    const databaseName = new URL(process.env.DATABASE_URL).pathname;
    if (!/test/i.test(databaseName)) {
      throw new Error(
        `Refusing to run Admin user fixtures against "${databaseName}"`,
      );
    }

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.listen(0);
    base = await app.getUrl();
    prisma = app.get(PrismaService);
    passwordService = app.get(PasswordService);
    issueToken = tokenIssuerFor(app);

    adminId = await createBaseUser('admin', Role.ADMIN);
    customerId = await createBaseUser('customer', Role.CUSTOMER);
  }, 120_000);

  afterAll(async () => {
    if (prisma) {
      await prisma.user.deleteMany({
        where: { id: { in: createdUserIds } },
      });
    }
    await app?.close();
  });

  it('creates active delivery staff, hashes the password, and rejects duplicate email', async () => {
    const input = validInput();
    const created = await api('POST', '/admin/users', {
      user: adminId,
      body: input,
    });

    expect(created.status).toBe(HttpStatus.CREATED);
    expect(created.body).toMatchObject({
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
      phone: input.phone,
      role: Role.DELIVERY_STAFF,
      status: 'ACTIVE',
    });
    expect(created.text).not.toContain('password');
    expect(created.text).not.toContain(input.password);

    const persisted = await prisma.user.findUniqueOrThrow({
      where: { id: created.body.id },
    });
    createdUserIds.push(persisted.id);
    expect(persisted.role).toBe(Role.DELIVERY_STAFF);
    expect(persisted.status).toBe('ACTIVE');
    expect(persisted.passwordHash).not.toBe(input.password);
    await expect(
      passwordService.verify(persisted.passwordHash, input.password),
    ).resolves.toBe(true);

    const duplicate = await api('POST', '/admin/users', {
      user: adminId,
      body: input,
    });
    expect(duplicate.status).toBe(HttpStatus.CONFLICT);
  });

  it.each([
    ['role', { role: Role.ADMIN }],
    ['status', { status: 'SUSPENDED' }],
  ])('does not accept client-controlled %s', async (_field, extra) => {
    const response = await api('POST', '/admin/users', {
      user: adminId,
      body: { ...validInput(`${_field}-${run}@example.test`), ...extra },
    });

    expect(response.status).toBe(HttpStatus.BAD_REQUEST);
  });

  it('refuses non-admin callers', async () => {
    const response = await api('POST', '/admin/users', {
      user: customerId,
      body: validInput(`forbidden-${run}@example.test`),
    });

    expect(response.status).toBe(HttpStatus.FORBIDDEN);
  });

  it('keeps public registration restricted to active CUSTOMER accounts', async () => {
    const input = validInput(`public-${run}@example.test`);
    const created = await api('POST', '/users', { body: input });

    expect(created.status).toBe(HttpStatus.CREATED);
    expect(created.body).toMatchObject({
      email: input.email,
      role: Role.CUSTOMER,
      status: 'ACTIVE',
    });
    expect(created.text).not.toContain('password');

    const persisted = await prisma.user.findUniqueOrThrow({
      where: { id: created.body.id },
    });
    createdUserIds.push(persisted.id);
    expect(persisted.role).toBe(Role.CUSTOMER);
    expect(persisted.status).toBe('ACTIVE');
  });

  it('rejects invalid required fields', async () => {
    const response = await api('POST', '/admin/users', {
      user: adminId,
      body: {
        ...validInput(`invalid-${run}@example.test`),
        firstName: 'A',
        email: 'not-an-email',
        password: 'short',
      },
    });

    expect(response.status).toBe(HttpStatus.BAD_REQUEST);
  });
});
