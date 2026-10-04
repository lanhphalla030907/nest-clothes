import {
  HttpStatus,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TEMPORARY_USER_ID_HEADER } from '../common/decorators/temporary-user-id.decorator.js';
import { AddressesController } from './addresses.controller.js';
import { AddressesService } from './addresses.service.js';
import { AddressResponseDto } from './dto/address-response.dto.js';
import { CreateAddressDto } from './dto/create-address.dto.js';
import { UpdateAddressDto } from './dto/update-address.dto.js';

const USER_ID = 'a1b2c3d4-e5f6-4f70-8a9b-0c1d2e3f4a5b';
const ADDRESS_ID = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f';

/** A complete address body, so each test only has to state what it changes. */
const VALID_BODY = {
  label: 'Home',
  recipientName: 'Ada Lovelace',
  phone: '+44 117 496 0000',
  addressLine1: '12 Mill Lane',
  city: 'Bristol',
  countryCode: 'GB',
};

const buildAddressResponse = (
  overrides: Partial<AddressResponseDto> = {},
): AddressResponseDto =>
  Object.assign(new AddressResponseDto(), {
    id: ADDRESS_ID,
    userId: USER_ID,
    label: 'Home',
    recipientName: 'Ada Lovelace',
    phone: '+44 117 496 0000',
    addressLine1: '12 Mill Lane',
    addressLine2: null,
    city: 'Bristol',
    stateProvince: null,
    postalCode: null,
    countryCode: 'GB',
    isDefault: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  });

const buildServiceMock = () => ({
  findAll: vi.fn(),
  findOne: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  setDefault: vi.fn(),
});

/**
 * HTTP-level tests: the controller is mounted in a real Nest application with the
 * same global `ValidationPipe` the app uses, so the routes, the status codes and the
 * request validation are exercised rather than assumed. The service is mocked, so
 * what arrives here is exactly what a controller is responsible for.
 */
describe('AddressesController (HTTP)', () => {
  let app: INestApplication;
  let service: ReturnType<typeof buildServiceMock>;
  let base: string;

  beforeAll(async () => {
    service = buildServiceMock();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AddressesController],
      providers: [{ provide: AddressesService, useValue: service }],
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
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.resetAllMocks();
  });

  const request = (
    method: string,
    path: string,
    options: { user?: string; body?: unknown } = {},
  ) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        ...(options.user === undefined
          ? {}
          : { [TEMPORARY_USER_ID_HEADER]: options.user }),
        ...(options.body === undefined
          ? {}
          : { 'Content-Type': 'application/json' }),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    });

  describe('GET /addresses', () => {
    it('returns 200 with the caller address book', async () => {
      service.findAll.mockResolvedValue([buildAddressResponse()]);

      const res = await request('GET', '/addresses', { user: USER_ID });
      const body = await res.json();

      expect(res.status).toBe(HttpStatus.OK);
      expect(service.findAll).toHaveBeenCalledWith(USER_ID);
      expect(body).toHaveLength(1);
      expect(body[0].id).toBe(ADDRESS_ID);
    });

    it('returns 200 with an empty list rather than 404 for a new account', async () => {
      service.findAll.mockResolvedValue([]);

      const res = await request('GET', '/addresses', { user: USER_ID });

      expect(res.status).toBe(HttpStatus.OK);
      expect(await res.json()).toEqual([]);
    });

    it('rejects a request without the identity header', async () => {
      const res = await request('GET', '/addresses');

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(service.findAll).not.toHaveBeenCalled();
    });

    it('rejects a malformed identity header before the service', async () => {
      const res = await request('GET', '/addresses', { user: 'not-a-uuid' });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(service.findAll).not.toHaveBeenCalled();
    });
  });

  describe('GET /addresses/:id', () => {
    it('returns 200 with the address', async () => {
      service.findOne.mockResolvedValue(buildAddressResponse());

      const res = await request('GET', `/addresses/${ADDRESS_ID}`, {
        user: USER_ID,
      });

      expect(res.status).toBe(HttpStatus.OK);
      expect(service.findOne).toHaveBeenCalledWith(USER_ID, ADDRESS_ID);
    });

    it('exposes exactly the documented fields and no user row', async () => {
      service.findOne.mockResolvedValue(buildAddressResponse());

      const res = await request('GET', `/addresses/${ADDRESS_ID}`, {
        user: USER_ID,
      });
      const body = await res.json();

      expect(Object.keys(body).sort()).toEqual(
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
      expect(JSON.stringify(body)).not.toContain('passwordHash');
      expect(JSON.stringify(body)).not.toContain('"user"');
    });

    it('answers 400 for a malformed id before the service', async () => {
      const res = await request('GET', '/addresses/not-a-uuid', {
        user: USER_ID,
      });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(service.findOne).not.toHaveBeenCalled();
    });

    it('passes the service 404 straight through for another user address', async () => {
      const { NotFoundException } = await import('@nestjs/common');
      service.findOne.mockRejectedValue(
        new NotFoundException(`Address ${ADDRESS_ID} does not exist`),
      );

      const res = await request('GET', `/addresses/${ADDRESS_ID}`, {
        user: USER_ID,
      });

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
    });
  });

  describe('POST /addresses', () => {
    it('returns 201 and passes the validated body to the service', async () => {
      service.create.mockResolvedValue(buildAddressResponse());

      const res = await request('POST', '/addresses', {
        user: USER_ID,
        body: VALID_BODY,
      });

      expect(res.status).toBe(HttpStatus.CREATED);
      expect(service.create).toHaveBeenCalledWith(
        USER_ID,
        expect.objectContaining({ label: 'Home', countryCode: 'GB' }),
      );
    });

    it('trims the text fields before the service sees them', async () => {
      service.create.mockResolvedValue(buildAddressResponse());

      await request('POST', '/addresses', {
        user: USER_ID,
        body: { ...VALID_BODY, label: '  Home  ', city: ' Bristol ' },
      });

      expect(service.create.mock.calls[0][1]).toMatchObject({
        label: 'Home',
        city: 'Bristol',
      });
    });

    it('normalises a lowercase country code', async () => {
      service.create.mockResolvedValue(buildAddressResponse());

      await request('POST', '/addresses', {
        user: USER_ID,
        body: { ...VALID_BODY, countryCode: 'gb' },
      });

      expect(service.create.mock.calls[0][1].countryCode).toBe('GB');
    });

    it('treats a blank optional field as absent rather than an empty string', async () => {
      service.create.mockResolvedValue(buildAddressResponse());

      await request('POST', '/addresses', {
        user: USER_ID,
        body: { ...VALID_BODY, addressLine2: '   ' },
      });

      expect(service.create.mock.calls[0][1].addressLine2).toBeNull();
    });

    it.each([
      ['a missing label', { label: undefined }],
      ['a blank label', { label: '   ' }],
      ['a missing recipientName', { recipientName: undefined }],
      ['a missing phone', { phone: undefined }],
      ['a missing addressLine1', { addressLine1: undefined }],
      ['a missing city', { city: undefined }],
      ['a missing countryCode', { countryCode: undefined }],
      ['a one-letter country code', { countryCode: 'G' }],
      ['a three-letter country code', { countryCode: 'GBR' }],
      ['a numeric country code', { countryCode: '12' }],
      ['a non-boolean isDefault', { isDefault: 'yes' }],
      ['a label longer than the column', { label: 'x'.repeat(51) }],
      [
        'a recipient name longer than the column',
        { recipientName: 'x'.repeat(151) },
      ],
      ['a phone longer than the column', { phone: '9'.repeat(31) }],
      ['a city longer than the column', { city: 'x'.repeat(101) }],
      [
        'an address line longer than the column',
        { addressLine1: 'x'.repeat(256) },
      ],
      ['a state longer than the column', { stateProvince: 'x'.repeat(101) }],
      ['a postal code longer than the column', { postalCode: 'x'.repeat(21) }],
    ])('rejects %s', async (_name, override) => {
      const body = { ...VALID_BODY, ...override };
      for (const key of Object.keys(override)) {
        if (body[key] === undefined) {
          delete body[key];
        }
      }

      const res = await request('POST', '/addresses', { user: USER_ID, body });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(service.create).not.toHaveBeenCalled();
    });

    it('accepts an unusually long but legal phone number', async () => {
      service.create.mockResolvedValue(buildAddressResponse());

      const res = await request('POST', '/addresses', {
        user: USER_ID,
        body: { ...VALID_BODY, phone: '+44 (117) 496-0000 ext. 1234' },
      });

      expect(res.status).toBe(HttpStatus.CREATED);
    });

    it.each([
      ['an unknown field', { nickname: 'Home' }],
      ['an attempt to set the owner', { userId: USER_ID }],
      ['an attempt to set the id', { id: ADDRESS_ID }],
      [
        'an attempt to set a timestamp',
        { createdAt: '2026-01-01T00:00:00.000Z' },
      ],
    ])('rejects %s rather than ignoring it', async (_name, extra) => {
      const res = await request('POST', '/addresses', {
        user: USER_ID,
        body: { ...VALID_BODY, ...extra },
      });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(service.create).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /addresses/:id', () => {
    it('returns 200 with the updated address', async () => {
      service.update.mockResolvedValue(
        buildAddressResponse({ label: 'Work', isDefault: true }),
      );

      const res = await request('PATCH', `/addresses/${ADDRESS_ID}`, {
        user: USER_ID,
        body: { label: 'Work' },
      });

      expect(res.status).toBe(HttpStatus.OK);
      expect(service.update).toHaveBeenCalledWith(
        USER_ID,
        ADDRESS_ID,
        expect.objectContaining({ label: 'Work' }),
      );
      expect((await res.json()).label).toBe('Work');
    });

    it('allows a single field to be patched', async () => {
      service.update.mockResolvedValue(buildAddressResponse());

      const res = await request('PATCH', `/addresses/${ADDRESS_ID}`, {
        user: USER_ID,
        body: { city: 'Bath' },
      });

      expect(res.status).toBe(HttpStatus.OK);
    });

    it('accepts an explicit null for a nullable field', async () => {
      service.update.mockResolvedValue(buildAddressResponse());

      const res = await request('PATCH', `/addresses/${ADDRESS_ID}`, {
        user: USER_ID,
        body: { addressLine2: null },
      });

      expect(res.status).toBe(HttpStatus.OK);
      expect(service.update.mock.calls[0][2].addressLine2).toBeNull();
    });

    it.each([
      ['a required field', 'city', null],
      ['the street line', 'addressLine1', null],
      ['the label', 'label', null],
    ])('refuses to null %s', async (_name, field, value) => {
      const res = await request('PATCH', `/addresses/${ADDRESS_ID}`, {
        user: USER_ID,
        body: { [field]: value },
      });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(service.update).not.toHaveBeenCalled();
    });

    it('rejects a malformed country code on a patch', async () => {
      const res = await request('PATCH', `/addresses/${ADDRESS_ID}`, {
        user: USER_ID,
        body: { countryCode: 'GBR' },
      });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('rejects an unknown field on a patch', async () => {
      const res = await request('PATCH', `/addresses/${ADDRESS_ID}`, {
        user: USER_ID,
        body: { isDefault: true, userId: USER_ID },
      });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(service.update).not.toHaveBeenCalled();
    });

    it('answers 400 for a malformed id before the service', async () => {
      const res = await request('PATCH', '/addresses/nope', {
        user: USER_ID,
        body: { label: 'Work' },
      });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(service.update).not.toHaveBeenCalled();
    });

    it('passes the service 409 for unsetting the default', async () => {
      const { ConflictException } = await import('@nestjs/common');
      service.update.mockRejectedValue(
        new ConflictException('The default address cannot be unset'),
      );

      const res = await request('PATCH', `/addresses/${ADDRESS_ID}`, {
        user: USER_ID,
        body: { isDefault: false },
      });

      expect(res.status).toBe(HttpStatus.CONFLICT);
    });
  });

  describe('POST /addresses/:id/default', () => {
    it('returns 200 with the promoted address', async () => {
      service.setDefault.mockResolvedValue(buildAddressResponse());

      const res = await request('POST', `/addresses/${ADDRESS_ID}/default`, {
        user: USER_ID,
      });

      expect(res.status).toBe(HttpStatus.OK);
      expect(service.setDefault).toHaveBeenCalledWith(USER_ID, ADDRESS_ID);
      expect((await res.json()).isDefault).toBe(true);
    });

    it('needs no body', async () => {
      service.setDefault.mockResolvedValue(buildAddressResponse());

      const res = await request('POST', `/addresses/${ADDRESS_ID}/default`, {
        user: USER_ID,
      });

      expect(res.status).toBe(HttpStatus.OK);
    });

    it('rejects a malformed identity header', async () => {
      const res = await request('POST', `/addresses/${ADDRESS_ID}/default`, {
        user: 'nope',
      });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(service.setDefault).not.toHaveBeenCalled();
    });

    it('answers 404 for an address belonging to another user', async () => {
      const { NotFoundException } = await import('@nestjs/common');
      service.setDefault.mockRejectedValue(
        new NotFoundException(`Address ${ADDRESS_ID} does not exist`),
      );

      const res = await request('POST', `/addresses/${ADDRESS_ID}/default`, {
        user: USER_ID,
      });

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
    });
  });

  describe('DELETE /addresses/:id', () => {
    it('returns 204 with no body', async () => {
      service.remove.mockResolvedValue(undefined);

      const res = await request('DELETE', `/addresses/${ADDRESS_ID}`, {
        user: USER_ID,
      });

      expect(res.status).toBe(HttpStatus.NO_CONTENT);
      expect(await res.text()).toBe('');
      expect(service.remove).toHaveBeenCalledWith(USER_ID, ADDRESS_ID);
    });

    it('rejects a malformed id before the service', async () => {
      const res = await request('DELETE', '/addresses/nope', { user: USER_ID });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(service.remove).not.toHaveBeenCalled();
    });

    it('answers 404 for an address belonging to another user', async () => {
      const { NotFoundException } = await import('@nestjs/common');
      service.remove.mockRejectedValue(
        new NotFoundException(`Address ${ADDRESS_ID} does not exist`),
      );

      const res = await request('DELETE', `/addresses/${ADDRESS_ID}`, {
        user: USER_ID,
      });

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
    });
  });

  describe('the controller itself', () => {
    it('delegates the list', () => {
      const controller = app.get(AddressesController);
      const expected = [buildAddressResponse()];
      service.findAll.mockReturnValue(expected);

      expect(controller.findAll(USER_ID)).toBe(expected);
    });

    it('delegates the create with the DTO instance', () => {
      const controller = app.get(AddressesController);
      const dto = Object.assign(new CreateAddressDto(), VALID_BODY);
      const expected = buildAddressResponse();
      service.create.mockReturnValue(expected);

      expect(controller.create(USER_ID, dto)).toBe(expected);
      expect(service.create).toHaveBeenCalledWith(USER_ID, dto);
    });

    it('delegates the patch with the id from the path', () => {
      const controller = app.get(AddressesController);
      const dto = Object.assign(new UpdateAddressDto(), { label: 'Work' });
      const expected = buildAddressResponse({ label: 'Work' });
      service.update.mockReturnValue(expected);

      expect(controller.update(USER_ID, ADDRESS_ID, dto)).toBe(expected);
      expect(service.update).toHaveBeenCalledWith(USER_ID, ADDRESS_ID, dto);
    });

    it('delegates the removal and the default transition', async () => {
      const controller = app.get(AddressesController);

      service.remove.mockResolvedValue(undefined);
      await expect(
        controller.remove(USER_ID, ADDRESS_ID),
      ).resolves.toBeUndefined();
      expect(service.remove).toHaveBeenCalledWith(USER_ID, ADDRESS_ID);

      const expected = buildAddressResponse();
      service.setDefault.mockReturnValue(expected);
      expect(controller.setDefault(USER_ID, ADDRESS_ID)).toBe(expected);
    });
  });
});
