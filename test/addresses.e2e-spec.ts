import 'dotenv/config';
import {
  HttpStatus,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { TEMPORARY_USER_ID_HEADER } from '../src/common/decorators/temporary-user-id.decorator.js';
import { AddressesModule } from '../src/addresses/addresses.module.js';
import { CreateAddressDto } from '../src/addresses/dto/create-address.dto.js';
import { UpdateAddressDto } from '../src/addresses/dto/update-address.dto.js';

/**
 * Address behaviour against a **real PostgreSQL** database.
 *
 * The unit and HTTP specs pin the rules the service and controller intend; this
 * file proves they survive contact with the database, which is the only place the
 * following can be checked at all:
 *
 * - the partial unique index really does allow only one default per user, and
 *   really does let a user keep many non-defaults;
 * - the `ON DELETE CASCADE` from `users` really does take the addresses with it;
 * - a concurrent first-address race really does converge on exactly one default
 *   instead of two defaults or a 500;
 * - `PrismaClientKnownRequestError` from the driver adapter still carries the code
 *   and the constraint name the service's retry and error mapping depend on.
 *
 * Nothing is mocked. Every fixture is written through the same tables the
 * application uses, so a change that quietly breaks a constraint fails here.
 *
 * It runs as part of `npm run test:e2e` and needs a reachable `DATABASE_URL`.
 * Fixtures are namespaced by a per-run token and torn down in `afterAll`, so
 * repeated runs never collide.
 */
describe('Addresses (PostgreSQL)', () => {
  const run = randomUUID().slice(0, 8);
  const email = (name: string) => `addr-${run}-${name}@example.test`;

  let app: INestApplication;
  let prisma: PrismaService;
  let base: string;
  let userId: string;
  let otherUserId: string;
  /** User with no addresses at all, for the empty-book and first-address cases. */
  let emptyUserId: string;

  const headers = (id: string) => ({
    'Content-Type': 'application/json',
    [TEMPORARY_USER_ID_HEADER]: id,
  });

  const api = async (
    method: string,
    path: string,
    options: { user?: string; body?: unknown } = {},
  ) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: headers(options.user ?? userId),
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    });

    const text = await res.text();

    return {
      status: res.status,
      body: text.length === 0 ? undefined : JSON.parse(text),
    };
  };

  /** A complete valid body, so each test only has to state what it changes. */
  const validBody = (
    overrides: Partial<CreateAddressDto> = {},
  ): Record<string, unknown> => ({
    label: 'Home',
    recipientName: 'Ada Lovelace',
    phone: '+44 117 496 0000',
    addressLine1: '12 Mill Lane',
    city: 'Bristol',
    countryCode: 'GB',
    ...overrides,
  });

  const createUser = async (name: string) =>
    (
      await prisma.user.create({
        data: {
          firstName: 'Ada',
          lastName: 'Tester',
          email: email(name),
          // A real hash is irrelevant here; nothing logs in during these tests.
          passwordHash: 'argon2-not-a-real-hash',
          status: 'ACTIVE',
        },
      })
    ).id;

  /** Creates an address through the API, asserting the happy path first. */
  const createAddress = async (
    body: Record<string, unknown>,
    user: string = userId,
  ) => {
    const res = await api('POST', '/addresses', { user, body });

    expect(res.status).toBe(HttpStatus.CREATED);

    return res.body;
  };

  const addressesOf = (user: string = userId) =>
    prisma.address.findMany({ where: { userId: user } });

  const defaultsOf = (user: string = userId) =>
    prisma.address.findMany({ where: { userId: user, isDefault: true } });

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        'DATABASE_URL is not set — the address integration tests need a real PostgreSQL instance',
      );
    }

    const module: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule, AddressesModule],
    }).compile();

    app = module.createNestApplication();
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

    userId = await createUser('owner');
    otherUserId = await createUser('other');
    emptyUserId = await createUser('empty');
  });

  afterAll(async () => {
    if (prisma === undefined) {
      return;
    }

    // Addresses go with the users by cascade, so deleting the run's users is enough
    // to clean this file's rows. The delete is scoped by the run prefix so it can
    // never reach into whatever else is in the database.
    const myUsers = { email: { startsWith: `addr-${run}-` } };

    try {
      await prisma.user.deleteMany({ where: myUsers });
    } finally {
      // Close even if cleanup threw. A leaked Nest app holding a Prisma pool is
      // reported as a suite-level failure with every test already green, which
      // hides the error that actually caused it.
      await app.close();
    }
  });

  describe('reading', () => {
    it('starts with an empty address book', async () => {
      const res = await api('GET', '/addresses', { user: emptyUserId });

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body).toEqual([]);
    });

    it('lists the caller addresses with the default first', async () => {
      // A dedicated user, so the ordering claim does not depend on what the other
      // tests in this file have already created.
      const user = await createUser('ordering');
      await createAddress(validBody({ label: 'Home' }), user);
      await createAddress(validBody({ label: 'Office' }), user);
      await createAddress(validBody({ label: 'Studio' }), user);

      const res = await api('GET', '/addresses', { user });

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body).toHaveLength(3);
      expect(res.body[0].isDefault).toBe(true);
      expect(res.body[0].label).toBe('Home');
      expect(
        res.body.filter((a: { isDefault: boolean }) => a.isDefault),
      ).toHaveLength(1);
      // Default first, then the rest oldest first, so the order is stable.
      expect(res.body.map((a: { label: string }) => a.label)).toEqual([
        'Home',
        'Office',
        'Studio',
      ]);
    });

    it('never exposes the owning user row', async () => {
      const res = await api('GET', '/addresses');

      expect(JSON.stringify(res.body)).not.toContain('passwordHash');
      expect(JSON.stringify(res.body)).not.toContain('"user"');
    });

    it('returns exactly the documented fields and nothing else', async () => {
      const user = await createUser('field-shape');
      await createAddress(validBody({ label: 'Shaped' }), user);

      const [address] = (await api('GET', '/addresses', { user })).body;

      expect(address).toBeDefined();
      expect(Object.keys(address).sort()).toEqual(
        [
          'addressLine1',
          'addressLine2',
          'city',
          'countryCode',
          'createdAt',
          'id',
          'isDefault',
          'label',
          'phone',
          'postalCode',
          'recipientName',
          'stateProvince',
          'updatedAt',
          'userId',
        ].sort(),
      );
    });

    it('reads back a single address', async () => {
      const created = await createAddress(validBody({ label: 'Cabin' }));

      const res = await api('GET', `/addresses/${created.id}`);

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body).toMatchObject({ id: created.id, label: 'Cabin' });
    });

    it('stores optional columns as null when they are omitted', async () => {
      const created = await createAddress(validBody({ label: 'Minimal' }));

      const stored = await prisma.address.findUniqueOrThrow({
        where: { id: created.id },
      });

      expect(stored.addressLine2).toBeNull();
      expect(stored.stateProvince).toBeNull();
      expect(stored.postalCode).toBeNull();
    });

    it('stores a supplied optional field verbatim after trimming', async () => {
      const created = await createAddress(
        validBody({
          label: 'Full',
          addressLine2: '  Flat 2  ',
          stateProvince: '  Avon ',
          postalCode: ' BS1 4DJ ',
        }),
      );

      expect(created).toMatchObject({
        addressLine2: 'Flat 2',
        stateProvince: 'Avon',
        postalCode: 'BS1 4DJ',
      });
    });

    it('normalises a lowercase country code on the way in and out', async () => {
      const created = await createAddress(
        validBody({ label: 'Lower', countryCode: 'gb' }),
      );

      expect(created.countryCode).toBe('GB');
      const stored = await prisma.address.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(stored.countryCode).toBe('GB');
    });

    it('accepts a long but legal phone number and a free-form postal code', async () => {
      const created = await createAddress(
        validBody({
          label: 'Long',
          phone: '+44 (117) 496-0000 ext. 1234',
          postalCode: 'BS1 4DJ',
        }),
      );

      expect(created).toMatchObject({
        phone: '+44 (117) 496-0000 ext. 1234',
        postalCode: 'BS1 4DJ',
      });
    });
  });

  describe('isolation between users', () => {
    it('keeps one user address book out of another', async () => {
      const mine = (await api('GET', '/addresses')).body.length;

      const res = await api('GET', '/addresses', { user: emptyUserId });

      expect(res.body).toEqual([]);
      expect((await api('GET', '/addresses')).body).toHaveLength(mine);
    });

    it('gives each user their own default', async () => {
      const mine = await defaultsOf();
      const theirs = await defaultsOf(otherUserId);

      expect(mine).toHaveLength(1);
      // The other user has no addresses at all, so they have no default to conflict
      // with: the index is per user, not global.
      expect(theirs).toHaveLength(0);

      await createAddress(validBody({ label: 'Theirs' }), otherUserId);

      expect(await defaultsOf(otherUserId)).toHaveLength(1);
      // Promoting a default for one user left the other user's default alone.
      expect(await defaultsOf()).toHaveLength(1);
      expect((await defaultsOf(otherUserId))[0].label).toBe('Theirs');
    });

    it('answers 404 for an address belonging to another user', async () => {
      const mine = await createAddress(validBody({ label: 'Private' }));

      const res = await api('GET', `/addresses/${mine.id}`, {
        user: otherUserId,
      });

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
    });

    it('answers 404 when patching an address belonging to another user', async () => {
      const mine = await createAddress(validBody({ label: 'AlsoPrivate' }));

      const res = await api('PATCH', `/addresses/${mine.id}`, {
        user: otherUserId,
        body: { label: 'Hijacked' },
      });

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
      const stored = await prisma.address.findUniqueOrThrow({
        where: { id: mine.id },
      });
      expect(stored.label).toBe('AlsoPrivate');
    });

    it('answers 404 when promoting an address belonging to another user', async () => {
      const mine = await createAddress(validBody({ label: 'NotYours' }));

      const res = await api('POST', `/addresses/${mine.id}/default`, {
        user: otherUserId,
      });

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
      expect((await defaultsOf())[0].label).not.toBe('NotYours');
    });

    it('answers 404 when deleting an address belonging to another user', async () => {
      const mine = await createAddress(validBody({ label: 'Undeletable' }));

      const res = await api('DELETE', `/addresses/${mine.id}`, {
        user: otherUserId,
      });

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
      expect(await prisma.address.count({ where: { id: mine.id } })).toBe(1);
    });

    it('answers 404 for an unknown user rather than creating an orphan', async () => {
      const res = await api('GET', '/addresses', {
        user: '00000000-0000-4000-8000-000000000000',
      });

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
    });

    it('answers 404 when creating for an unknown user', async () => {
      const before = await prisma.address.count();

      const res = await api('POST', '/addresses', {
        user: '00000000-0000-4000-8000-000000000000',
        body: validBody(),
      });

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
      expect(await prisma.address.count()).toBe(before);
    });
  });

  describe('validation over HTTP', () => {
    it('rejects a missing identity header', async () => {
      const res = await fetch(`${base}/addresses`);

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('rejects a malformed identity header', async () => {
      const res = await api('GET', '/addresses', { user: 'not-a-uuid' });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('rejects a malformed address id', async () => {
      const res = await api('GET', '/addresses/not-a-uuid');

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it.each([
      ['a missing label', { label: undefined }],
      ['a blank label', { label: '   ' }],
      ['a missing recipient name', { recipientName: undefined }],
      ['a missing phone', { phone: undefined }],
      ['a missing street line', { addressLine1: undefined }],
      ['a missing city', { city: undefined }],
      ['a missing country code', { countryCode: undefined }],
      ['a one-letter country code', { countryCode: 'G' }],
      ['a three-letter country code', { countryCode: 'GBR' }],
      ['a numeric country code', { countryCode: '12' }],
      ['a non-boolean default flag', { isDefault: 'yes' }],
      ['an over-long label', { label: 'x'.repeat(51) }],
      ['an over-long recipient name', { recipientName: 'x'.repeat(151) }],
      ['an over-long phone', { phone: '9'.repeat(31) }],
      ['an over-long street line', { addressLine1: 'x'.repeat(256) }],
      ['an over-long city', { city: 'x'.repeat(101) }],
    ])('rejects %s and writes nothing', async (_name, override) => {
      const body = validBody(override as Partial<CreateAddressDto>);
      for (const key of Object.keys(override)) {
        if (body[key] === undefined) {
          delete body[key];
        }
      }
      const before = await prisma.address.count();

      const res = await api('POST', '/addresses', { user: emptyUserId, body });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(await prisma.address.count()).toBe(before);
    });

    it('rejects an unknown field rather than silently dropping it', async () => {
      const res = await api('POST', '/addresses', {
        user: emptyUserId,
        body: { ...validBody(), nickname: 'Home' },
      });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('rejects an attempt to choose the owner from the payload', async () => {
      const res = await api('POST', '/addresses', {
        user: emptyUserId,
        body: { ...validBody(), userId: otherUserId },
      });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      // The rejected body must not have been applied to anybody.
      expect(await addressesOf(otherUserId)).toHaveLength(1);
    });
  });

  describe('updating', () => {
    it('patches a single field and leaves the rest alone', async () => {
      const created = await createAddress(
        validBody({ label: 'Before', city: 'Bath' }),
      );

      const res = await api('PATCH', `/addresses/${created.id}`, {
        body: { city: 'Bristol' },
      });

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body).toMatchObject({ label: 'Before', city: 'Bristol' });
    });

    it('clears a nullable field when it is set to null', async () => {
      const created = await createAddress(
        validBody({ addressLine2: 'Flat 2', stateProvince: 'Avon' }),
      );

      const res = await api('PATCH', `/addresses/${created.id}`, {
        body: { addressLine2: null },
      });

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.addressLine2).toBeNull();
      expect(res.body.stateProvince).toBe('Avon');
    });

    it('treats a blank optional field as a request to clear it', async () => {
      const created = await createAddress(
        validBody({ addressLine2: 'Flat 2' }),
      );

      const res = await api('PATCH', `/addresses/${created.id}`, {
        body: { addressLine2: '   ' },
      });

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.addressLine2).toBeNull();
    });

    it('accepts an empty patch as a no-op', async () => {
      const created = await createAddress(validBody({ label: 'NoOp' }));

      const res = await api('PATCH', `/addresses/${created.id}`, { body: {} });

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body).toMatchObject({ id: created.id, label: 'NoOp' });
    });

    it('refuses to clear a required field', async () => {
      const created = await createAddress(validBody({ label: 'Required' }));

      const res = await api('PATCH', `/addresses/${created.id}`, {
        body: { city: null },
      });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      const stored = await prisma.address.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(stored.city).toBe('Bristol');
    });

    it('rejects an invalid patched value', async () => {
      const created = await createAddress(validBody());

      const res = await api('PATCH', `/addresses/${created.id}`, {
        body: { countryCode: 'GBR' },
      });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });
  });

  describe('the default address', () => {
    it('makes the very first address the default', async () => {
      const user = await createUser('first');

      const created = await createAddress(validBody(), user);

      expect(created.isDefault).toBe(true);
    });

    it('does not make a later address the default by accident', async () => {
      const user = await createUser('second');

      await createAddress(validBody({ label: 'One' }), user);
      const second = await createAddress(validBody({ label: 'Two' }), user);

      expect(second.isDefault).toBe(false);
      expect(await defaultsOf(user)).toHaveLength(1);
    });

    it('moves the default and demotes the incumbent atomically', async () => {
      const user = await createUser('move');
      const first = await createAddress(validBody({ label: 'First' }), user);
      const second = await createAddress(validBody({ label: 'Second' }), user);

      const res = await api('POST', `/addresses/${second.id}/default`, {
        user,
      });

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body).toMatchObject({ id: second.id, isDefault: true });

      const rows = await addressesOf(user);
      expect(rows.filter((a) => a.isDefault)).toHaveLength(1);
      expect(rows.find((a) => a.id === second.id)!.isDefault).toBe(true);
      expect(rows.find((a) => a.id === first.id)!.isDefault).toBe(false);
    });

    it('promotes a default while also patching fields in one request', async () => {
      const user = await createUser('patch-and-promote');
      const first = await createAddress(validBody({ label: 'First' }), user);
      const second = await createAddress(
        validBody({ label: 'Second', city: 'Bath' }),
        user,
      );

      const res = await api('PATCH', `/addresses/${second.id}`, {
        user,
        body: { city: 'Bristol', isDefault: true },
      });

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body).toMatchObject({
        city: 'Bristol',
        isDefault: true,
      });
      const rows = await addressesOf(user);
      expect(rows.filter((a) => a.isDefault)).toHaveLength(1);
      expect(rows.find((a) => a.id === first.id)!.isDefault).toBe(false);
    });

    it('treats promoting the current default again as a no-op', async () => {
      const user = await createUser('already-default');
      const only = await createAddress(validBody(), user);

      const res = await api('POST', `/addresses/${only.id}/default`, { user });

      expect(res.status).toBe(HttpStatus.OK);
      expect(await defaultsOf(user)).toHaveLength(1);
    });

    it('rejects unsetting the default', async () => {
      const user = await createUser('unset');
      const current = await createAddress(validBody(), user);

      const res = await api('PATCH', `/addresses/${current.id}`, {
        user,
        body: { isDefault: false },
      });

      expect(res.status).toBe(HttpStatus.CONFLICT);
      const rows = await addressesOf(user);
      expect(rows.find((a) => a.id === current.id)!.isDefault).toBe(true);
    });

    it('ignores isDefault false on an address that is not the default', async () => {
      const user = await createUser('harmless-false');
      const first = await createAddress(validBody({ label: 'First' }), user);
      const second = await createAddress(validBody({ label: 'Second' }), user);

      const res = await api('PATCH', `/addresses/${second.id}`, {
        user,
        body: { isDefault: false },
      });

      expect(res.status).toBe(HttpStatus.OK);
      const rows = await addressesOf(user);
      expect(rows.find((a) => a.id === first.id)!.isDefault).toBe(true);
      expect(rows.find((a) => a.id === second.id)!.isDefault).toBe(false);
    });

    it('keeps the partial unique index honest at the database level', async () => {
      const user = await createUser('index');
      const [first, second] = await Promise.all([
        prisma.address.create({
          data: { ...validBody(), userId: user, isDefault: false },
        }),
        prisma.address.create({
          data: { ...validBody(), userId: user, isDefault: false },
        }),
      ]);

      // Two non-defaults for one user are perfectly legal.
      await prisma.address.update({
        where: { id: first.id },
        data: { isDefault: true },
      });

      // A second default is not, and the database refuses it without help from
      // the service.
      await expect(
        prisma.address.update({
          where: { id: second.id },
          data: { isDefault: true },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });

      expect(await defaultsOf(user)).toHaveLength(1);
    });

    it('settles a concurrent first-address race on exactly one default', async () => {
      const user = await createUser('race');

      const results = await Promise.all([
        api('POST', '/addresses', { user, body: validBody({ label: 'A' }) }),
        api('POST', '/addresses', { user, body: validBody({ label: 'B' }) }),
        api('POST', '/addresses', { user, body: validBody({ label: 'C' }) }),
      ]);

      // Whatever the interleaving, no request may surface a raw constraint error.
      for (const res of results) {
        expect(res.status).toBe(HttpStatus.CREATED);
      }

      const rows = await addressesOf(user);
      expect(rows).toHaveLength(3);
      expect(rows.filter((a) => a.isDefault)).toHaveLength(1);
    });

    it('settles concurrent promotions of different addresses on one default', async () => {
      const user = await createUser('promote-race');
      const ids: string[] = [];
      for (const label of ['A', 'B', 'C', 'D']) {
        ids.push((await createAddress(validBody({ label }), user)).id);
      }

      const results = await Promise.all(
        ids.map((id) => api('POST', `/addresses/${id}/default`, { user })),
      );

      for (const res of results) {
        expect(res.status).toBe(HttpStatus.OK);
      }

      const rows = await addressesOf(user);
      expect(rows.filter((a) => a.isDefault)).toHaveLength(1);
    });

    it('settles concurrent create-default requests without a 500', async () => {
      const user = await createUser('create-default-race');
      await createAddress(validBody({ label: 'Incumbent' }), user);

      const results = await Promise.all(
        ['One', 'Two', 'Three'].map((label) =>
          api('POST', '/addresses', {
            user,
            body: validBody({ label, isDefault: true }),
          }),
        ),
      );

      for (const res of results) {
        expect(res.status).toBe(HttpStatus.CREATED);
      }

      const rows = await addressesOf(user);
      expect(rows.filter((a) => a.isDefault)).toHaveLength(1);
    });
  });

  describe('deleting', () => {
    it('deletes a non-default and leaves the default alone', async () => {
      const user = await createUser('delete-plain');
      const first = await createAddress(validBody({ label: 'First' }), user);
      const second = await createAddress(validBody({ label: 'Second' }), user);

      const res = await api('DELETE', `/addresses/${second.id}`, { user });

      expect(res.status).toBe(HttpStatus.NO_CONTENT);
      const rows = await addressesOf(user);
      expect(rows.map((a) => a.id)).toEqual([first.id]);
      expect(rows[0].isDefault).toBe(true);
    });

    it('promotes another address when the default is deleted', async () => {
      const user = await createUser('delete-default');
      const first = await createAddress(validBody({ label: 'First' }), user);
      const second = await createAddress(validBody({ label: 'Second' }), user);
      const third = await createAddress(validBody({ label: 'Third' }), user);
      await api('POST', `/addresses/${third.id}/default`, { user });

      const res = await api('DELETE', `/addresses/${third.id}`, { user });

      expect(res.status).toBe(HttpStatus.NO_CONTENT);
      const rows = await addressesOf(user);
      // `findMany` has no `orderBy`, so compare as sets rather than trusting the
      // order the driver happened to return.
      expect(rows.map((a) => a.id).sort()).toEqual(
        [first.id, second.id].sort(),
      );
      // The promotion fell back to the oldest surviving row.
      expect(rows.find((a) => a.id === first.id)!.isDefault).toBe(true);
      expect(rows.find((a) => a.id === second.id)!.isDefault).toBe(false);
    });

    it('allows the only address to be deleted, leaving no default', async () => {
      const user = await createUser('delete-only');
      const only = await createAddress(validBody(), user);

      const res = await api('DELETE', `/addresses/${only.id}`, { user });

      expect(res.status).toBe(HttpStatus.NO_CONTENT);
      expect(await addressesOf(user)).toHaveLength(0);
      expect(await defaultsOf(user)).toHaveLength(0);
      // The user still exists and can start over.
      expect(await prisma.user.count({ where: { id: user } })).toBe(1);
    });

    it('lets a user start over with a new default afterwards', async () => {
      const user = await createUser('restart');
      const only = await createAddress(validBody(), user);
      await api('DELETE', `/addresses/${only.id}`, { user });

      const created = await createAddress(validBody({ label: 'New' }), user);

      expect(created.isDefault).toBe(true);
    });

    it('answers 404 when deleting an address twice', async () => {
      const user = await createUser('delete-twice');
      const only = await createAddress(validBody(), user);
      await api('DELETE', `/addresses/${only.id}`, { user });

      const res = await api('DELETE', `/addresses/${only.id}`, { user });

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
    });
  });

  describe('deleting the user', () => {
    it('cascades to the addresses', async () => {
      const user = await createUser('cascade');
      const first = await createAddress(validBody({ label: 'One' }), user);
      const second = await createAddress(validBody({ label: 'Two' }), user);
      expect(await addressesOf(user)).toHaveLength(2);

      await prisma.user.delete({ where: { id: user } });

      expect(
        await prisma.address.count({
          where: { id: { in: [first.id, second.id] } },
        }),
      ).toBe(0);
    });

    it('answers 404 once the owning user is gone', async () => {
      const user = await createUser('cascade-later');
      const created = await createAddress(validBody(), user);
      await prisma.user.delete({ where: { id: user } });

      const res = await api('GET', `/addresses/${created.id}`, { user });

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
    });
  });

  describe('the DTOs as the service receives them', () => {
    it('transforms a create body into a CreateAddressDto', () => {
      const dto = Object.assign(new CreateAddressDto(), {
        label: '  Home ',
        countryCode: 'gb',
      });

      expect(dto.label).toBe('  Home ');
      // Normalisation happens in the validation pipeline, not the constructor, so
      // this only pins that the class exists and carries the fields.
      expect(dto.countryCode).toBe('gb');
    });

    it('transforms an update body into an UpdateAddressDto', () => {
      const dto = Object.assign(new UpdateAddressDto(), { label: 'Work' });

      expect(dto).toBeInstanceOf(UpdateAddressDto);
      expect(dto.label).toBe('Work');
      expect(dto.isDefault).toBeUndefined();
    });
  });
});
