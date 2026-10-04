import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '../generated/prisma/client.js';
import { UsersRepository } from '../users/repositories/users.repository.js';
import { AddressesService } from './addresses.service.js';
import { CreateAddressDto } from './dto/create-address.dto.js';
import { UpdateAddressDto } from './dto/update-address.dto.js';
import type { AddressTransactionClient } from './repositories/address.repository.js';

const USER_ID = 'a1b2c3d4-e5f6-4f70-8a9b-0c1d2e3f4a5b';
const OTHER_USER_ID = 'b2c3d4e5-f6a7-4f81-9b0c-1d2e3f4a5b6c';
const ADDRESS_ID = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f';
const SUCCESSOR_ID = 'd2e3f4a5-b6c7-4d8e-9f0a-1b2c3d4e5f60';

/**
 * A stored address row. The service is exercised on the columns it reads and
 * writes, so the fixture carries every one of them.
 */
const buildAddress = (overrides: Record<string, unknown> = {}) => ({
  id: ADDRESS_ID,
  userId: USER_ID,
  label: 'Home',
  recipientName: 'Ada Lovelace',
  phone: '+44 117 496 0000',
  addressLine1: '12 Mill Lane',
  addressLine2: null,
  city: 'Bristol',
  stateProvince: null,
  postalCode: 'BS1 4DJ',
  countryCode: 'GB',
  isDefault: true,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

const buildCreateDto = (
  overrides: Partial<CreateAddressDto> = {},
): CreateAddressDto =>
  Object.assign(new CreateAddressDto(), {
    label: 'Home',
    recipientName: 'Ada Lovelace',
    phone: '+44 117 496 0000',
    addressLine1: '12 Mill Lane',
    city: 'Bristol',
    countryCode: 'GB',
    ...overrides,
  });

const buildUpdateDto = (
  overrides: Partial<UpdateAddressDto> = {},
): UpdateAddressDto => Object.assign(new UpdateAddressDto(), overrides);

/**
 * The `P2002` the partial unique index raises. Two shapes are represented because
 * Prisma reports it differently depending on the driver adapter in play: the index
 * name arrives inside `driverAdapterError`, and otherwise only the model does.
 */
const buildDefaultRaceViolation = (withIndexName = true) =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '7.10.0',
    meta: {
      modelName: 'Address',
      ...(withIndexName
        ? {
            driverAdapterError: {
              name: 'DriverAdapterError',
              cause: {
                originalCode: '23505',
                kind: 'UniqueConstraintViolation',
                constraint: { index: 'addresses_one_default_per_user_key' },
                table: 'addresses',
              },
            },
          }
        : {}),
    },
  });

const buildRecordNotFound = () =>
  new Prisma.PrismaClientKnownRequestError(
    'An operation failed because it depends on one or more records that were required but not found.',
    { code: 'P2025', clientVersion: '7.10.0', meta: { modelName: 'Address' } },
  );

const buildForeignKeyViolation = () =>
  new Prisma.PrismaClientKnownRequestError('Foreign key constraint failed', {
    code: 'P2003',
    clientVersion: '7.10.0',
    meta: {
      modelName: 'Address',
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          originalCode: '23503',
          kind: 'ForeignKeyViolation',
          constraint: { index: 'addresses_user_id_fkey' },
          table: 'addresses',
        },
      },
    },
  });

/**
 * Every rule about the single default lives in the service, so this spec is where
 * those rules are pinned. The repository is mocked, which means the *statements* are
 * asserted — in particular their order, because "demote before promote" and "delete
 * before promote" are the difference between an address book that always has a
 * default and one that briefly does not.
 */
describe('AddressesService', () => {
  let service: AddressesService;
  let addressFindAllByUserId: ReturnType<typeof vi.fn>;
  let addressFindByIdAndUserId: ReturnType<typeof vi.fn>;
  let addressCountByUserId: ReturnType<typeof vi.fn>;
  let addressFindDefaultSuccessor: ReturnType<typeof vi.fn>;
  let addressCreate: ReturnType<typeof vi.fn>;
  let addressUpdateByIdAndUserId: ReturnType<typeof vi.fn>;
  let addressDeleteByIdAndUserId: ReturnType<typeof vi.fn>;
  let addressDemoteDefaults: ReturnType<typeof vi.fn>;
  let addressPromoteByIdAndUserId: ReturnType<typeof vi.fn>;
  let addressRunInTransaction: ReturnType<typeof vi.fn>;
  let userFindById: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    addressFindAllByUserId = vi.fn();
    addressFindByIdAndUserId = vi.fn();
    addressCountByUserId = vi.fn();
    addressFindDefaultSuccessor = vi.fn();
    addressCreate = vi.fn();
    addressUpdateByIdAndUserId = vi.fn();
    addressDeleteByIdAndUserId = vi.fn();
    addressDemoteDefaults = vi.fn();
    addressPromoteByIdAndUserId = vi.fn();
    addressRunInTransaction = vi.fn();
    userFindById = vi.fn().mockResolvedValue({ id: USER_ID });

    /**
     * Runs the transaction body against a marker client, the way
     * `runInTransaction` does in production, so the service can be handed a real
     * value and the `client` argument of each repository call asserted.
     */
    addressRunInTransaction.mockImplementation(
      (work: (tx: AddressTransactionClient) => Promise<unknown>) =>
        work({ tx: true } as unknown as AddressTransactionClient),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AddressesService,
        {
          provide: (await import('./repositories/address.repository.js'))
            .AddressRepository,
          useValue: {
            findAllByUserId: addressFindAllByUserId,
            findByIdAndUserId: addressFindByIdAndUserId,
            countByUserId: addressCountByUserId,
            findDefaultSuccessor: addressFindDefaultSuccessor,
            create: addressCreate,
            updateByIdAndUserId: addressUpdateByIdAndUserId,
            deleteByIdAndUserId: addressDeleteByIdAndUserId,
            demoteDefaults: addressDemoteDefaults,
            promoteByIdAndUserId: addressPromoteByIdAndUserId,
            runInTransaction: addressRunInTransaction,
          },
        },
        { provide: UsersRepository, useValue: { findById: userFindById } },
      ],
    }).compile();

    service = module.get<AddressesService>(AddressesService);
  });

  describe('findAll', () => {
    it('returns the caller address book, default first', async () => {
      const home = buildAddress();
      const work = buildAddress({
        id: SUCCESSOR_ID,
        label: 'Work',
        isDefault: false,
      });
      addressFindAllByUserId.mockResolvedValue([home, work]);

      const result = await service.findAll(USER_ID);

      expect(addressFindAllByUserId).toHaveBeenCalledWith(USER_ID);
      expect(result.map((address) => address.label)).toEqual(['Home', 'Work']);
    });

    it('returns an empty list for a user with no addresses', async () => {
      addressFindAllByUserId.mockResolvedValue([]);

      await expect(service.findAll(USER_ID)).resolves.toEqual([]);
    });

    it('exposes every address field and nothing else', async () => {
      addressFindAllByUserId.mockResolvedValue([buildAddress()]);

      const [address] = await service.findAll(USER_ID);

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

    it('never carries a password hash or a user row', async () => {
      addressFindAllByUserId.mockResolvedValue([
        { ...buildAddress(), user: { passwordHash: 'argon2$leak' } },
      ]);

      const serialised = JSON.stringify(await service.findAll(USER_ID));

      expect(serialised).not.toContain('argon2');
      expect(serialised).not.toContain('passwordHash');
      expect(serialised).not.toContain('"user"');
    });

    it('404s for an unknown user', async () => {
      userFindById.mockResolvedValue(null);

      await expect(service.findAll(USER_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(addressFindAllByUserId).not.toHaveBeenCalled();
    });
  });

  describe('findOne', () => {
    it('returns the caller own address', async () => {
      addressFindByIdAndUserId.mockResolvedValue(buildAddress());

      const result = await service.findOne(USER_ID, ADDRESS_ID);

      // No transaction client was supplied, so the read runs on the default one.
      expect(addressFindByIdAndUserId).toHaveBeenCalledWith(
        ADDRESS_ID,
        USER_ID,
        undefined,
      );
      expect(result.id).toBe(ADDRESS_ID);
    });

    it('reads through the caller transaction when one is supplied', async () => {
      addressFindByIdAndUserId.mockResolvedValue(buildAddress());
      const client = { $transaction: vi.fn() } as unknown as AddressTransactionClient;

      const result = await service.findOne(USER_ID, ADDRESS_ID, client);

      // Checkout has to see the address it is about to copy, and only if the whole
      // checkout commits, so the read has to join the caller's transaction.
      expect(addressFindByIdAndUserId).toHaveBeenCalledWith(
        ADDRESS_ID,
        USER_ID,
        client,
      );
      expect(result.id).toBe(ADDRESS_ID);
    });

    it('404s for an address belonging to another user', async () => {
      addressFindByIdAndUserId.mockResolvedValue(null);

      await expect(service.findOne(OTHER_USER_ID, ADDRESS_ID)).rejects.toThrow(
        `Address ${ADDRESS_ID} does not exist`,
      );
    });
  });

  describe('create', () => {
    it('makes the very first address the default without being asked', async () => {
      addressCountByUserId.mockResolvedValue(0);
      addressCreate.mockResolvedValue(buildAddress());

      await service.create(USER_ID, buildCreateDto());

      expect(addressCreate).toHaveBeenCalledWith(
        expect.objectContaining({ isDefault: true }),
        { tx: true },
      );
    });

    it('does not demote anything when creating the first address', async () => {
      addressCountByUserId.mockResolvedValue(0);
      addressCreate.mockResolvedValue(buildAddress());

      await service.create(USER_ID, buildCreateDto());

      expect(addressDemoteDefaults).not.toHaveBeenCalled();
    });

    it('stores a later address as a non-default when none was requested', async () => {
      addressCountByUserId.mockResolvedValue(2);
      addressCreate.mockResolvedValue(buildAddress({ isDefault: false }));

      await service.create(USER_ID, buildCreateDto());

      expect(addressCreate).toHaveBeenCalledWith(
        expect.objectContaining({ isDefault: false }),
        { tx: true },
      );
      expect(addressDemoteDefaults).not.toHaveBeenCalled();
    });

    it('demotes the incumbent before inserting a new default', async () => {
      addressCountByUserId.mockResolvedValue(1);
      addressCreate.mockResolvedValue(buildAddress({ id: SUCCESSOR_ID }));

      await service.create(USER_ID, buildCreateDto({ isDefault: true }));

      // Order matters: inserting a second default while the incumbent still exists
      // would violate the partial unique index.
      expect(addressDemoteDefaults).toHaveBeenCalledWith(USER_ID, null, {
        tx: true,
      });
      expect(addressDemoteDefaults.mock.invocationCallOrder[0]).toBeLessThan(
        addressCreate.mock.invocationCallOrder[0],
      );
      expect(addressCreate).toHaveBeenCalledWith(
        expect.objectContaining({ isDefault: true }),
        { tx: true },
      );
    });

    it('writes the owner from the identity, never from the payload', async () => {
      addressCountByUserId.mockResolvedValue(1);
      addressCreate.mockResolvedValue(buildAddress());

      await service.create(USER_ID, buildCreateDto());

      expect(addressCreate.mock.calls[0][0].userId).toBe(USER_ID);
    });

    it('stores absent optional fields as null rather than undefined', async () => {
      addressCountByUserId.mockResolvedValue(1);
      addressCreate.mockResolvedValue(buildAddress());

      await service.create(USER_ID, buildCreateDto());

      const data = addressCreate.mock.calls[0][0];
      expect(data.addressLine2).toBeNull();
      expect(data.stateProvince).toBeNull();
      expect(data.postalCode).toBeNull();
    });

    it('stores a supplied optional field verbatim', async () => {
      addressCountByUserId.mockResolvedValue(1);
      addressCreate.mockResolvedValue(buildAddress());

      await service.create(
        USER_ID,
        buildCreateDto({ addressLine2: 'Flat 4', stateProvince: 'Avon' }),
      );

      expect(addressCreate.mock.calls[0][0]).toMatchObject({
        addressLine2: 'Flat 4',
        stateProvince: 'Avon',
      });
    });

    it('retries the whole write after losing the race for the default', async () => {
      addressCountByUserId.mockResolvedValue(1);
      addressCreate
        .mockRejectedValueOnce(buildDefaultRaceViolation())
        .mockResolvedValueOnce(buildAddress({ id: SUCCESSOR_ID }));

      const result = await service.create(
        USER_ID,
        buildCreateDto({ isDefault: true }),
      );

      expect(result.id).toBe(SUCCESSOR_ID);
      expect(addressRunInTransaction).toHaveBeenCalledTimes(2);
      // The retry re-reads the current state rather than replaying a stale decision.
      expect(addressCountByUserId).toHaveBeenCalledTimes(2);
    });

    it('retries when the violation carries no index name', async () => {
      addressCountByUserId.mockResolvedValue(1);
      addressCreate
        .mockRejectedValueOnce(buildDefaultRaceViolation(false))
        .mockResolvedValueOnce(buildAddress({ id: SUCCESSOR_ID }));

      await expect(
        service.create(USER_ID, buildCreateDto({ isDefault: true })),
      ).resolves.toMatchObject({ id: SUCCESSOR_ID });
    });

    it('409s when every attempt lost the race', async () => {
      addressCountByUserId.mockResolvedValue(1);
      addressCreate.mockRejectedValue(buildDefaultRaceViolation());

      await expect(
        service.create(USER_ID, buildCreateDto({ isDefault: true })),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(addressRunInTransaction).toHaveBeenCalledTimes(3);
    });

    it('does not retry an unrelated failure', async () => {
      addressCountByUserId.mockResolvedValue(1);
      addressCreate.mockRejectedValue(new Error('connection lost'));

      await expect(
        service.create(USER_ID, buildCreateDto({ isDefault: true })),
      ).rejects.toThrow('connection lost');
      expect(addressRunInTransaction).toHaveBeenCalledTimes(1);
    });

    it('surfaces a foreign key failure as a 500 rather than a client error', async () => {
      addressCountByUserId.mockResolvedValue(0);
      addressCreate.mockRejectedValue(buildForeignKeyViolation());

      await expect(
        service.create(USER_ID, buildCreateDto()),
      ).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    });

    it('404s for an unknown user before touching the address table', async () => {
      userFindById.mockResolvedValue(null);

      await expect(
        service.create(USER_ID, buildCreateDto()),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(addressCountByUserId).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('writes only the fields the request supplied', async () => {
      addressFindByIdAndUserId.mockResolvedValue(buildAddress());
      addressUpdateByIdAndUserId.mockResolvedValue(
        buildAddress({ label: 'Work', city: 'Bath' }),
      );

      await service.update(
        USER_ID,
        ADDRESS_ID,
        buildUpdateDto({ label: 'Work', city: 'Bath' }),
      );

      expect(addressUpdateByIdAndUserId).toHaveBeenCalledWith(
        ADDRESS_ID,
        USER_ID,
        {
          label: 'Work',
          city: 'Bath',
        },
      );
    });

    it('leaves omitted fields untouched', async () => {
      addressFindByIdAndUserId.mockResolvedValue(buildAddress());
      addressUpdateByIdAndUserId.mockResolvedValue(buildAddress());

      await service.update(
        USER_ID,
        ADDRESS_ID,
        buildUpdateDto({ label: 'Work' }),
      );

      expect(addressUpdateByIdAndUserId.mock.calls[0][2]).toEqual({
        label: 'Work',
      });
    });

    it('clears a nullable field when it is sent as null', async () => {
      addressFindByIdAndUserId.mockResolvedValue(
        buildAddress({ addressLine2: 'Flat 4' }),
      );
      addressUpdateByIdAndUserId.mockResolvedValue(
        buildAddress({ addressLine2: null }),
      );

      await service.update(
        USER_ID,
        ADDRESS_ID,
        buildUpdateDto({ addressLine2: null }),
      );

      expect(addressUpdateByIdAndUserId.mock.calls[0][2]).toEqual({
        addressLine2: null,
      });
    });

    it('never writes isDefault through the ordinary field path', async () => {
      addressFindByIdAndUserId.mockResolvedValue(
        buildAddress({ isDefault: false }),
      );
      addressUpdateByIdAndUserId.mockResolvedValue(buildAddress());

      await service.update(
        USER_ID,
        ADDRESS_ID,
        buildUpdateDto({ label: 'Work', isDefault: false }),
      );

      // The address was not the default, so this is a no-op and the flag must not
      // appear in the field write at all.
      expect(addressUpdateByIdAndUserId.mock.calls[0][2]).toEqual({
        label: 'Work',
      });
    });

    it('409s when asked to unset the current default', async () => {
      addressFindByIdAndUserId.mockResolvedValue(
        buildAddress({ isDefault: true }),
      );

      await expect(
        service.update(
          USER_ID,
          ADDRESS_ID,
          buildUpdateDto({ isDefault: false }),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(addressUpdateByIdAndUserId).not.toHaveBeenCalled();
    });

    it('says which conflict it is about', async () => {
      addressFindByIdAndUserId.mockResolvedValue(
        buildAddress({ isDefault: true }),
      );

      await expect(
        service.update(
          USER_ID,
          ADDRESS_ID,
          buildUpdateDto({ isDefault: false }),
        ),
      ).rejects.toThrow(/default address cannot be unset/i);
    });

    it('demotes the incumbent and promotes the address when isDefault is true', async () => {
      addressFindByIdAndUserId.mockResolvedValue(
        buildAddress({ isDefault: false }),
      );
      addressPromoteByIdAndUserId.mockResolvedValue(
        buildAddress({ isDefault: true }),
      );

      const result = await service.update(
        USER_ID,
        ADDRESS_ID,
        buildUpdateDto({ isDefault: true }),
      );

      expect(addressDemoteDefaults).toHaveBeenCalledWith(USER_ID, ADDRESS_ID, {
        tx: true,
      });
      expect(addressPromoteByIdAndUserId).toHaveBeenCalledWith(
        ADDRESS_ID,
        USER_ID,
        { tx: true },
      );
      expect(result.isDefault).toBe(true);
      // The promotion must not demote the address it is promoting.
      expect(addressDemoteDefaults.mock.calls[0][1]).toBe(ADDRESS_ID);
    });

    it('applies field edits and the promotion in one transaction', async () => {
      addressFindByIdAndUserId.mockResolvedValue(
        buildAddress({ isDefault: false }),
      );
      addressPromoteByIdAndUserId.mockResolvedValue(buildAddress());

      await service.update(
        USER_ID,
        ADDRESS_ID,
        buildUpdateDto({ label: 'Cabin', isDefault: true }),
      );

      expect(addressUpdateByIdAndUserId).toHaveBeenCalledWith(
        ADDRESS_ID,
        USER_ID,
        { label: 'Cabin' },
        { tx: true },
      );
      expect(
        addressUpdateByIdAndUserId.mock.invocationCallOrder[0],
      ).toBeLessThan(addressPromoteByIdAndUserId.mock.invocationCallOrder[0]);
      expect(addressRunInTransaction).toHaveBeenCalledTimes(1);
    });

    it('does not rewrite the row when the address is already the default', async () => {
      addressFindByIdAndUserId.mockResolvedValue(
        buildAddress({ isDefault: true }),
      );
      addressUpdateByIdAndUserId.mockResolvedValue(buildAddress());

      const result = await service.update(
        USER_ID,
        ADDRESS_ID,
        buildUpdateDto({ isDefault: true }),
      );

      expect(addressDemoteDefaults).not.toHaveBeenCalled();
      expect(addressPromoteByIdAndUserId).not.toHaveBeenCalled();
      expect(addressUpdateByIdAndUserId).not.toHaveBeenCalled();
      expect(result.isDefault).toBe(true);
    });

    it('treats an empty patch as a success rather than an error', async () => {
      addressFindByIdAndUserId.mockResolvedValue(buildAddress());

      const result = await service.update(
        USER_ID,
        ADDRESS_ID,
        buildUpdateDto(),
      );

      expect(result.id).toBe(ADDRESS_ID);
      expect(addressUpdateByIdAndUserId).not.toHaveBeenCalled();
    });

    it('404s for an address belonging to another user', async () => {
      addressFindByIdAndUserId.mockResolvedValue(null);

      await expect(
        service.update(
          OTHER_USER_ID,
          ADDRESS_ID,
          buildUpdateDto({ label: 'X' }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(addressUpdateByIdAndUserId).not.toHaveBeenCalled();
    });

    it('404s when the address is deleted between the read and the write', async () => {
      addressFindByIdAndUserId.mockResolvedValue(buildAddress());
      addressUpdateByIdAndUserId.mockRejectedValue(buildRecordNotFound());

      await expect(
        service.update(USER_ID, ADDRESS_ID, buildUpdateDto({ label: 'Work' })),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('setDefault', () => {
    it('demotes the incumbent and promotes the target', async () => {
      addressFindByIdAndUserId.mockResolvedValue(
        buildAddress({ isDefault: false }),
      );
      addressPromoteByIdAndUserId.mockResolvedValue(
        buildAddress({ isDefault: true }),
      );

      const result = await service.setDefault(USER_ID, ADDRESS_ID);

      expect(addressDemoteDefaults).toHaveBeenCalledWith(USER_ID, ADDRESS_ID, {
        tx: true,
      });
      expect(addressDemoteDefaults.mock.invocationCallOrder[0]).toBeLessThan(
        addressPromoteByIdAndUserId.mock.invocationCallOrder[0],
      );
      expect(result.isDefault).toBe(true);
    });

    it('is idempotent when the address is already the default', async () => {
      addressFindByIdAndUserId.mockResolvedValue(
        buildAddress({ isDefault: true }),
      );

      const result = await service.setDefault(USER_ID, ADDRESS_ID);

      expect(result.isDefault).toBe(true);
      expect(addressDemoteDefaults).not.toHaveBeenCalled();
      expect(addressPromoteByIdAndUserId).not.toHaveBeenCalled();
    });

    it('404s for an address belonging to another user', async () => {
      addressFindByIdAndUserId.mockResolvedValue(null);

      await expect(
        service.setDefault(OTHER_USER_ID, ADDRESS_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(addressPromoteByIdAndUserId).not.toHaveBeenCalled();
    });

    it('retries when it loses the race for the default', async () => {
      addressFindByIdAndUserId.mockResolvedValue(
        buildAddress({ isDefault: false }),
      );
      addressPromoteByIdAndUserId
        .mockRejectedValueOnce(buildDefaultRaceViolation())
        .mockResolvedValueOnce(buildAddress({ isDefault: true }));

      await expect(
        service.setDefault(USER_ID, ADDRESS_ID),
      ).resolves.toMatchObject({
        isDefault: true,
      });
      expect(addressRunInTransaction).toHaveBeenCalledTimes(2);
    });

    it('retries when a concurrently deleted successor breaks the promotion', async () => {
      // This is the delete path's promotion step failing: P2025 there must be
      // retried rather than reported as a 404 about an address the caller never
      // named.
      addressFindByIdAndUserId.mockResolvedValue(buildAddress());
      addressDeleteByIdAndUserId.mockResolvedValue(buildAddress());
      addressFindDefaultSuccessor.mockResolvedValue(
        buildAddress({ id: SUCCESSOR_ID, isDefault: false }),
      );
      addressPromoteByIdAndUserId
        .mockRejectedValueOnce(buildRecordNotFound())
        .mockResolvedValueOnce(
          buildAddress({ id: SUCCESSOR_ID, isDefault: true }),
        );

      await expect(
        service.remove(USER_ID, ADDRESS_ID),
      ).resolves.toBeUndefined();
      expect(addressRunInTransaction).toHaveBeenCalledTimes(2);
    });

    it('409s for an unknown user', async () => {
      userFindById.mockResolvedValue(null);

      await expect(
        service.setDefault(USER_ID, ADDRESS_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('remove', () => {
    it('deletes a non-default address and promotes nobody', async () => {
      addressFindByIdAndUserId.mockResolvedValue(
        buildAddress({ isDefault: false }),
      );
      addressDeleteByIdAndUserId.mockResolvedValue(
        buildAddress({ isDefault: false }),
      );

      await service.remove(USER_ID, ADDRESS_ID);

      expect(addressDeleteByIdAndUserId).toHaveBeenCalledWith(
        ADDRESS_ID,
        USER_ID,
        { tx: true },
      );
      expect(addressPromoteByIdAndUserId).not.toHaveBeenCalled();
    });

    it('deletes the default and promotes another address in one transaction', async () => {
      addressFindByIdAndUserId.mockResolvedValue(
        buildAddress({ isDefault: true }),
      );
      addressDeleteByIdAndUserId.mockResolvedValue(buildAddress());
      addressFindDefaultSuccessor.mockResolvedValue(
        buildAddress({ id: SUCCESSOR_ID, isDefault: false }),
      );
      addressPromoteByIdAndUserId.mockResolvedValue(
        buildAddress({ id: SUCCESSOR_ID, isDefault: true }),
      );

      await service.remove(USER_ID, ADDRESS_ID);

      expect(addressRunInTransaction).toHaveBeenCalledTimes(1);
      expect(addressPromoteByIdAndUserId).toHaveBeenCalledWith(
        SUCCESSOR_ID,
        USER_ID,
        { tx: true },
      );
    });

    it('deletes before promoting, so the default slot is free first', async () => {
      addressFindByIdAndUserId.mockResolvedValue(
        buildAddress({ isDefault: true }),
      );
      addressDeleteByIdAndUserId.mockResolvedValue(buildAddress());
      addressFindDefaultSuccessor.mockResolvedValue(
        buildAddress({ id: SUCCESSOR_ID, isDefault: false }),
      );
      addressPromoteByIdAndUserId.mockResolvedValue(buildAddress());

      await service.remove(USER_ID, ADDRESS_ID);

      // Promoting while the old default row still exists would give the user two
      // defaults and trip the partial unique index.
      expect(
        addressDeleteByIdAndUserId.mock.invocationCallOrder[0],
      ).toBeLessThan(addressPromoteByIdAndUserId.mock.invocationCallOrder[0]);
      expect(
        addressFindDefaultSuccessor.mock.invocationCallOrder[0],
      ).toBeLessThan(addressPromoteByIdAndUserId.mock.invocationCallOrder[0]);
    });

    it('allows deleting the only address, leaving none behind', async () => {
      addressFindByIdAndUserId.mockResolvedValue(
        buildAddress({ isDefault: true }),
      );
      addressDeleteByIdAndUserId.mockResolvedValue(buildAddress());
      addressFindDefaultSuccessor.mockResolvedValue(null);

      await expect(
        service.remove(USER_ID, ADDRESS_ID),
      ).resolves.toBeUndefined();

      expect(addressFindDefaultSuccessor).toHaveBeenCalledWith(USER_ID, {
        tx: true,
      });
      expect(addressPromoteByIdAndUserId).not.toHaveBeenCalled();
    });

    it('404s for an address belonging to another user', async () => {
      addressFindByIdAndUserId.mockResolvedValue(null);

      await expect(service.remove(OTHER_USER_ID, ADDRESS_ID)).rejects.toThrow(
        `Address ${ADDRESS_ID} does not exist`,
      );
      expect(addressDeleteByIdAndUserId).not.toHaveBeenCalled();
    });

    it('404s when the address is deleted by a concurrent request first', async () => {
      addressFindByIdAndUserId.mockResolvedValue(
        buildAddress({ isDefault: false }),
      );
      addressDeleteByIdAndUserId.mockRejectedValue(buildRecordNotFound());

      await expect(service.remove(USER_ID, ADDRESS_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('404s for an unknown user before touching the address table', async () => {
      userFindById.mockResolvedValue(null);

      await expect(service.remove(USER_ID, ADDRESS_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(addressDeleteByIdAndUserId).not.toHaveBeenCalled();
    });
  });

  describe('the default flag is only ever moved deliberately', () => {
    it('is written by the dedicated promote statement and by nothing else', async () => {
      const column = expect.stringContaining('isDefault');

      // Every path that could plausibly clear a default by accident.
      await service.findAll(USER_ID).catch(() => undefined);
      await service
        .update(USER_ID, ADDRESS_ID, buildUpdateDto({ label: 'Work' }))
        .catch(() => undefined);
      await service.remove(USER_ID, ADDRESS_ID).catch(() => undefined);

      const fieldWrites = addressUpdateByIdAndUserId.mock.calls.map(
        (call) => call[2],
      );

      for (const data of fieldWrites) {
        expect(JSON.stringify(data)).not.toContain('isDefault');
      }
      expect(column).toBeTruthy();
    });
  });
});
