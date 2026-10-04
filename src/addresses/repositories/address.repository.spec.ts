import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  AddressRepository,
  type CreateAddressData,
} from './address.repository.js';

const USER_ID = 'u-1';
const ADDRESS_ID = 'a-1';
const SUCCESSOR_ID = 'a-2';

/** A stored address row, with every column the feature reads or writes. */
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

const buildCreateData = (
  overrides: Partial<CreateAddressData> = {},
): CreateAddressData => ({
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
  ...overrides,
});

/**
 * The repository is exercised against the *shape* it queries and writes: a mock
 * `PrismaService` whose model methods record the arguments they were called with,
 * so a test can assert not only that a row came back but that the owner was part of
 * the filter. That is the property this repository exists to provide, and asserting
 * only the return value would not catch a missing `userId`.
 */
describe('AddressRepository', () => {
  let repository: AddressRepository;
  let addressFindMany: ReturnType<typeof vi.fn>;
  let addressFindFirst: ReturnType<typeof vi.fn>;
  let addressCount: ReturnType<typeof vi.fn>;
  let addressCreate: ReturnType<typeof vi.fn>;
  let addressUpdate: ReturnType<typeof vi.fn>;
  let addressDelete: ReturnType<typeof vi.fn>;
  let addressUpdateMany: ReturnType<typeof vi.fn>;
  let transaction: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    addressFindMany = vi.fn();
    addressFindFirst = vi.fn();
    addressCount = vi.fn();
    addressCreate = vi.fn();
    addressUpdate = vi.fn();
    addressDelete = vi.fn();
    addressUpdateMany = vi.fn();
    transaction = vi.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AddressRepository,
        {
          provide: PrismaService,
          useValue: {
            address: {
              findMany: addressFindMany,
              findFirst: addressFindFirst,
              count: addressCount,
              create: addressCreate,
              update: addressUpdate,
              delete: addressDelete,
              updateMany: addressUpdateMany,
            },
            $transaction: transaction,
          },
        },
      ],
    }).compile();

    repository = module.get<AddressRepository>(AddressRepository);
  });

  it('should be defined', () => {
    expect(repository).toBeDefined();
  });

  describe('runInTransaction', () => {
    it('delegates to $transaction and forwards its result', async () => {
      const expected = buildAddress();
      transaction.mockImplementation(
        (work: (tx: unknown) => Promise<unknown>) => work({ tx: true }),
      );

      await expect(
        repository.runInTransaction(vi.fn().mockResolvedValue(expected)),
      ).resolves.toBe(expected);

      expect(transaction).toHaveBeenCalledTimes(1);
    });

    it('hands the work a client bound to the transaction', async () => {
      transaction.mockImplementation(
        (work: (tx: unknown) => Promise<unknown>) => work({ tx: true }),
      );

      await repository.runInTransaction(vi.fn().mockResolvedValue(undefined));

      const work = transaction.mock.calls[0][0];
      expect(work).toHaveBeenCalledWith({ tx: true });
    });

    it('propagates a rejection so the transaction rolls back', async () => {
      const failure = new Error('write failed');
      transaction.mockRejectedValue(failure);

      await expect(
        repository.runInTransaction(vi.fn().mockResolvedValue(undefined)),
      ).rejects.toBe(failure);
    });
  });

  describe('findAllByUserId', () => {
    it('scopes the query to the user and orders the default first', async () => {
      const expected = [buildAddress()];
      addressFindMany.mockResolvedValue(expected);

      await expect(repository.findAllByUserId(USER_ID)).resolves.toBe(expected);

      expect(addressFindMany).toHaveBeenCalledWith({
        where: { userId: USER_ID },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
      });
    });

    it('returns an empty list for a user with no addresses', async () => {
      addressFindMany.mockResolvedValue([]);

      await expect(repository.findAllByUserId(USER_ID)).resolves.toEqual([]);
    });

    it('reads through the transaction client when one is given', async () => {
      const txFindMany = vi.fn().mockResolvedValue([]);
      const tx = { address: { findMany: txFindMany } };

      await expect(repository.findAllByUserId(USER_ID, tx)).resolves.toEqual(
        [],
      );

      expect(txFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: USER_ID } }),
      );
      expect(addressFindMany).not.toHaveBeenCalled();
    });
  });

  describe('findByIdAndUserId', () => {
    it('filters by owner in the query rather than comparing afterwards', async () => {
      const expected = buildAddress();
      addressFindFirst.mockResolvedValue(expected);

      await expect(
        repository.findByIdAndUserId(ADDRESS_ID, USER_ID),
      ).resolves.toBe(expected);

      expect(addressFindFirst).toHaveBeenCalledWith({
        where: { id: ADDRESS_ID, userId: USER_ID },
      });
    });

    it('returns null when the address is absent or owned by someone else', async () => {
      addressFindFirst.mockResolvedValue(null);

      await expect(
        repository.findByIdAndUserId(ADDRESS_ID, USER_ID),
      ).resolves.toBeNull();
    });
  });

  describe('countByUserId', () => {
    it('counts only the given user addresses', async () => {
      addressCount.mockResolvedValue(3);

      await expect(repository.countByUserId(USER_ID)).resolves.toBe(3);
      expect(addressCount).toHaveBeenCalledWith({ where: { userId: USER_ID } });
    });

    it('reports zero for a user who has saved none', async () => {
      addressCount.mockResolvedValue(0);

      await expect(repository.countByUserId(USER_ID)).resolves.toBe(0);
    });
  });

  describe('findDefaultSuccessor', () => {
    it('takes the oldest non-default address', async () => {
      const expected = buildAddress({ id: SUCCESSOR_ID, isDefault: false });
      addressFindFirst.mockResolvedValue(expected);

      await expect(repository.findDefaultSuccessor(USER_ID)).resolves.toBe(
        expected,
      );

      expect(addressFindFirst).toHaveBeenCalledWith({
        where: { userId: USER_ID, isDefault: false },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
    });

    it('returns null when there is nothing left to promote', async () => {
      addressFindFirst.mockResolvedValue(null);

      await expect(
        repository.findDefaultSuccessor(USER_ID),
      ).resolves.toBeNull();
    });
  });

  describe('create', () => {
    it('writes every column it is given', async () => {
      const data = buildCreateData();
      const expected = buildAddress();
      addressCreate.mockResolvedValue(expected);

      await expect(repository.create(data)).resolves.toBe(expected);
      expect(addressCreate).toHaveBeenCalledWith({ data });
    });

    it('stores the owner it was given, never one from the payload', async () => {
      addressCreate.mockResolvedValue(buildAddress());

      await repository.create(buildCreateData({ userId: 'someone-else' }));

      expect(addressCreate.mock.calls[0][0].data.userId).toBe('someone-else');
    });
  });

  describe('updateByIdAndUserId', () => {
    it('scopes the write to the owner', async () => {
      const expected = buildAddress({ label: 'Work' });
      addressUpdate.mockResolvedValue(expected);

      await expect(
        repository.updateByIdAndUserId(ADDRESS_ID, USER_ID, { label: 'Work' }),
      ).resolves.toBe(expected);

      expect(addressUpdate).toHaveBeenCalledWith({
        where: { id: ADDRESS_ID, userId: USER_ID },
        data: { label: 'Work' },
      });
    });

    it('writes only the keys it is given, so omitted columns are untouched', async () => {
      addressUpdate.mockResolvedValue(buildAddress());

      await repository.updateByIdAndUserId(ADDRESS_ID, USER_ID, {
        city: 'Bath',
      });

      expect(addressUpdate.mock.calls[0][0].data).toEqual({ city: 'Bath' });
    });

    it("propagates P2025 when the address is absent or not the caller's", async () => {
      const missing = Object.assign(new Error('not found'), { code: 'P2025' });
      addressUpdate.mockRejectedValue(missing);

      await expect(
        repository.updateByIdAndUserId(ADDRESS_ID, USER_ID, { label: 'Work' }),
      ).rejects.toBe(missing);
    });
  });

  describe('deleteByIdAndUserId', () => {
    it('scopes the delete to the owner and returns the removed row', async () => {
      const expected = buildAddress();
      addressDelete.mockResolvedValue(expected);

      await expect(
        repository.deleteByIdAndUserId(ADDRESS_ID, USER_ID),
      ).resolves.toBe(expected);

      expect(addressDelete).toHaveBeenCalledWith({
        where: { id: ADDRESS_ID, userId: USER_ID },
      });
    });

    it("propagates P2025 rather than deleting somebody else's address", async () => {
      const missing = Object.assign(new Error('not found'), { code: 'P2025' });
      addressDelete.mockRejectedValue(missing);

      await expect(
        repository.deleteByIdAndUserId(ADDRESS_ID, USER_ID),
      ).rejects.toBe(missing);
    });
  });

  describe('demoteDefaults', () => {
    it('clears the default for the whole user when no address is spared', async () => {
      addressUpdateMany.mockResolvedValue({ count: 1 });

      await expect(repository.demoteDefaults(USER_ID, null)).resolves.toBe(1);

      expect(addressUpdateMany).toHaveBeenCalledWith({
        where: { userId: USER_ID, isDefault: true },
        data: { isDefault: false },
      });
    });

    it('spares the address that is about to be promoted', async () => {
      addressUpdateMany.mockResolvedValue({ count: 1 });

      await repository.demoteDefaults(USER_ID, ADDRESS_ID);

      expect(addressUpdateMany).toHaveBeenCalledWith({
        where: {
          userId: USER_ID,
          isDefault: true,
          id: { not: ADDRESS_ID },
        },
        data: { isDefault: false },
      });
    });

    it('reports zero when the user has no default to demote', async () => {
      addressUpdateMany.mockResolvedValue({ count: 0 });

      await expect(repository.demoteDefaults(USER_ID, null)).resolves.toBe(0);
    });
  });

  describe('promoteByIdAndUserId', () => {
    it('sets the flag on the addressed address only', async () => {
      const expected = buildAddress({ isDefault: true });
      addressUpdate.mockResolvedValue(expected);

      await expect(
        repository.promoteByIdAndUserId(ADDRESS_ID, USER_ID),
      ).resolves.toBe(expected);

      expect(addressUpdate).toHaveBeenCalledWith({
        where: { id: ADDRESS_ID, userId: USER_ID },
        data: { isDefault: true },
      });
    });

    it('propagates P2025 when the address is gone', async () => {
      const missing = Object.assign(new Error('not found'), { code: 'P2025' });
      addressUpdate.mockRejectedValue(missing);

      await expect(
        repository.promoteByIdAndUserId(ADDRESS_ID, USER_ID),
      ).rejects.toBe(missing);
    });
  });

  describe('transaction client plumbing', () => {
    it('routes every write through the supplied client, never the root one', async () => {
      const txCreate = vi.fn().mockResolvedValue(buildAddress());
      const txUpdate = vi.fn().mockResolvedValue(buildAddress());
      const txDelete = vi.fn().mockResolvedValue(buildAddress());
      const txUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
      const tx = {
        address: {
          create: txCreate,
          update: txUpdate,
          delete: txDelete,
          updateMany: txUpdateMany,
        },
      };

      await repository.create(buildCreateData(), tx);
      await repository.updateByIdAndUserId(ADDRESS_ID, USER_ID, {}, tx);
      await repository.deleteByIdAndUserId(ADDRESS_ID, USER_ID, tx);
      await repository.demoteDefaults(USER_ID, null, tx);
      await repository.promoteByIdAndUserId(ADDRESS_ID, USER_ID, tx);

      expect(txCreate).toHaveBeenCalledTimes(1);
      expect(txUpdate).toHaveBeenCalledTimes(2);
      expect(txDelete).toHaveBeenCalledTimes(1);
      expect(txUpdateMany).toHaveBeenCalledTimes(1);

      // Nothing touched the root client, which is the property that matters: a
      // write that escaped the transaction would neither roll back with it nor be
      // visible to the rest of the transaction.
      expect(addressCreate).not.toHaveBeenCalled();
      expect(addressUpdate).not.toHaveBeenCalled();
      expect(addressDelete).not.toHaveBeenCalled();
      expect(addressUpdateMany).not.toHaveBeenCalled();
    });
  });
});
