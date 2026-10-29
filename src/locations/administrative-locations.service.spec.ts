import { BadRequestException, ConflictException } from '@nestjs/common';
import type { AdministrativeLocation } from '../generated/prisma/client.js';
import { AdministrativeLocationsService } from './administrative-locations.service.js';
import { AdministrativeLocationsRepository } from './repositories/administrative-locations.repository.js';
import type { LocationTransactionClient } from './repositories/administrative-locations.repository.js';

const province = (codEnabledOverride: boolean | null): AdministrativeLocation =>
  ({
    pcode: 'KH12',
    parentPcode: null,
    adminLevel: 1,
    nameEn: 'Phnom Penh',
    nameKm: null,
    codEnabledOverride,
    createdAt: new Date(),
    updatedAt: new Date(),
  }) as AdministrativeLocation;

const district = (
  codEnabledOverride: boolean | null,
): AdministrativeLocation =>
  ({
    pcode: 'KH1201',
    parentPcode: 'KH12',
    adminLevel: 2,
    nameEn: 'Chamkar Mon',
    nameKm: null,
    codEnabledOverride,
    createdAt: new Date(),
    updatedAt: new Date(),
  }) as AdministrativeLocation;

const commune = (
  codEnabledOverride: boolean | null,
): AdministrativeLocation =>
  ({
    pcode: 'KH120101',
    parentPcode: 'KH1201',
    adminLevel: 3,
    nameEn: 'Tonle Bassac',
    nameKm: null,
    codEnabledOverride,
    createdAt: new Date(),
    updatedAt: new Date(),
  }) as AdministrativeLocation;

describe('AdministrativeLocationsService', () => {
  const repository = {
    findPath: vi.fn(),
    findByPcode: vi.fn(),
    listChildren: vi.fn(),
    updateCodOverride: vi.fn(),
    hasCodOverridesBelow: vi.fn(),
  };
  const service = new AdministrativeLocationsService(
    repository as unknown as AdministrativeLocationsRepository,
  );
  const transaction = {} as LocationTransactionClient;

  beforeEach(() => vi.resetAllMocks());

  it('accepts a complete province/district/commune path', async () => {
    repository.findPath.mockResolvedValue([
      province(true),
      district(null),
      commune(null),
    ]);

    await expect(service.requireCommune('KH120101', transaction)).resolves.toHaveLength(3);
    expect(repository.findPath).toHaveBeenCalledWith('KH120101', transaction);
  });

  it('rejects a selected location that is not a complete hierarchical path', async () => {
    repository.findPath.mockResolvedValue([province(true), commune(null)]);

    await expect(service.requireCommune('KH120101')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('accepts a province as the canonical Cambodia address location', async () => {
    repository.findPath.mockResolvedValue([province(true)]);

    await expect(
      service.requireProvince('KH12', transaction),
    ).resolves.toHaveLength(1);
  });

  it('rejects a district or commune where the address requires a province', async () => {
    repository.findPath.mockResolvedValue([
      province(true),
      district(null),
      commune(null),
    ]);

    await expect(
      service.requireProvince('KH120101', transaction),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('denies COD when the province is disabled even if a commune override allows it', async () => {
    repository.findPath.mockResolvedValue([
      province(false),
      district(null),
      commune(true),
    ]);

    await expect(
      service.assertCodEligible('KH120101', transaction),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('uses the deepest explicit rule for a subarea when the province is enabled', async () => {
    repository.findPath.mockResolvedValue([
      province(true),
      district(false),
      commune(true),
    ]);

    await expect(
      service.assertCodEligible('KH120101', transaction),
    ).resolves.toHaveLength(3);
  });

  it('denies a subarea when its deepest explicit rule disables COD', async () => {
    repository.findPath.mockResolvedValue([
      province(true),
      district(true),
      commune(false),
    ]);

    await expect(
      service.assertCodEligible('KH120101', transaction),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('allows province-only COD only when no descendant overrides are configured', async () => {
    repository.findPath.mockResolvedValue([province(true)]);
    repository.hasCodOverridesBelow.mockResolvedValue(false);

    await expect(
      service.assertCodEligible('KH12', transaction),
    ).resolves.toHaveLength(1);
    expect(repository.hasCodOverridesBelow).toHaveBeenCalledWith(
      'KH12',
      transaction,
    );
  });

  it('fails closed for province-only COD when any subarea override exists', async () => {
    repository.findPath.mockResolvedValue([province(true)]);
    repository.hasCodOverridesBelow.mockResolvedValue(true);

    await expect(
      service.assertCodEligible('KH12', transaction),
    ).rejects.toMatchObject({
      response: {
        message: expect.stringContaining('district or commune COD overrides'),
      },
    });
  });

  it('denies province-only COD when the province is disabled', async () => {
    repository.findPath.mockResolvedValue([province(false)]);

    await expect(
      service.assertCodEligible('KH12', transaction),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(repository.hasCodOverridesBelow).not.toHaveBeenCalled();
  });

  it('treats missing paths as not eligible', async () => {
    repository.findPath.mockResolvedValue(null);

    await expect(
      service.assertCodEligible('KH999999', transaction),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
