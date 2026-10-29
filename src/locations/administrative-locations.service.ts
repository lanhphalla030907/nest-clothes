import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AdministrativeLocation } from '../generated/prisma/client.js';
import { AdministrativeLocationResponseDto } from './dto/administrative-location-response.dto.js';
import { AdminCodEligibilityResponseDto } from './dto/admin-cod-eligibility-response.dto.js';
import type { UpdateCodEligibilityDto } from './dto/update-cod-eligibility.dto.js';
import {
  AdministrativeLocationsRepository,
  type LocationTransactionClient,
} from './repositories/administrative-locations.repository.js';

export type AdministrativeLocationPath = AdministrativeLocation[];

const COD_UNAVAILABLE_MESSAGE =
  'Cash on Delivery is unavailable for this address. Choose ABA PayWay or update the Cambodia address.';

@Injectable()
export class AdministrativeLocationsService {
  constructor(
    private readonly locationsRepository: AdministrativeLocationsRepository,
  ) {}

  async listChildren(
    parentPcode?: string,
  ): Promise<AdministrativeLocationResponseDto[]> {
    if (parentPcode !== undefined) {
      const parent = await this.locationsRepository.findByPcode(parentPcode);
      if (parent === null || parent.adminLevel >= 3) {
        throw new BadRequestException(
          'parentPcode must identify a province or district with child locations',
        );
      }
    }
    const locations = await this.locationsRepository.listChildren(
      parentPcode ?? null,
    );
    return locations.map(AdministrativeLocationResponseDto.fromEntity);
  }

  async listCodEligibility(
    parentPcode?: string,
  ): Promise<AdminCodEligibilityResponseDto[]> {
    if (parentPcode !== undefined) {
      const parent = await this.locationsRepository.findByPcode(parentPcode);
      if (parent === null || parent.adminLevel >= 3) {
        throw new BadRequestException(
          'parentPcode must identify a province or district with child locations',
        );
      }
    }
    const locations = await this.locationsRepository.listChildren(
      parentPcode ?? null,
    );
    return Promise.all(
      locations.map(async (location) =>
        AdminCodEligibilityResponseDto.fromValues(
          location,
          await this.isCodEligible(location.pcode),
        ),
      ),
    );
  }

  async updateCodEligibility(
    pcode: string,
    dto: UpdateCodEligibilityDto,
  ): Promise<AdminCodEligibilityResponseDto> {
    if (dto.codEnabledOverride === undefined) {
      throw new BadRequestException('codEnabledOverride is required');
    }
    const location = await this.locationsRepository.findByPcode(pcode);
    if (location === null) {
      throw new NotFoundException('Administrative location not found');
    }
    const updated = await this.locationsRepository.updateCodOverride(
      pcode,
      dto.codEnabledOverride,
    );
    return AdminCodEligibilityResponseDto.fromValues(
      updated,
      await this.isCodEligible(pcode),
    );
  }

  async requireCommune(
    pcode: string | undefined,
    client?: LocationTransactionClient,
  ): Promise<AdministrativeLocationPath> {
    if (pcode === undefined) {
      throw new BadRequestException(
        'Select a province, district, and commune for a Cambodia address',
      );
    }
    const path = await this.locationsRepository.findPath(pcode, client);
    if (
      path === null ||
      path.length !== 3 ||
      path[0].adminLevel !== 1 ||
      path[1].adminLevel !== 2 ||
      path[2].adminLevel !== 3
    ) {
      throw new BadRequestException(
        'The selected Cambodia location is not a valid province/district/commune path',
      );
    }
    return path;
  }

  async requireProvince(
    pcode: string | undefined,
    client?: LocationTransactionClient,
  ): Promise<AdministrativeLocationPath> {
    if (pcode === undefined) {
      throw new BadRequestException(
        'Select a Cambodia province or municipality',
      );
    }
    const path = await this.locationsRepository.findPath(pcode, client);
    if (path === null || path.length !== 1 || path[0].adminLevel !== 1) {
      throw new BadRequestException(
        'The selected Cambodia location is not a valid province or municipality',
      );
    }
    return path;
  }

  async getPath(
    pcode: string | null,
    client?: LocationTransactionClient,
    lockForShare = false,
  ): Promise<AdministrativeLocationPath | null> {
    if (pcode === null) return null;
    const path = await this.locationsRepository.findPath(
      pcode,
      client,
      lockForShare,
    );
    return path;
  }

  async assertCodEligible(
    pcode: string | null,
    client: LocationTransactionClient,
  ): Promise<AdministrativeLocationPath> {
    const path = await this.getPath(pcode, client, true);
    if (path === null || path.length === 0 || path[0].adminLevel !== 1) {
      throw new ConflictException(COD_UNAVAILABLE_MESSAGE);
    }

    const province = path[0];
    if (province.codEnabledOverride !== true) {
      throw new ConflictException(
        'Cash on Delivery is disabled for this province. Choose ABA PayWay or contact the studio.',
      );
    }

    if (path.length === 1) {
      if (await this.locationsRepository.hasCodOverridesBelow(province.pcode, client)) {
        throw new ConflictException(
          'Cash on Delivery cannot be verified for this address while district or commune COD overrides are configured. Choose ABA PayWay.',
        );
      }
      return path;
    }

    if (
      path.length !== 3 ||
      path[1].adminLevel !== 2 ||
      path[2].adminLevel !== 3
    ) {
      throw new ConflictException(COD_UNAVAILABLE_MESSAGE);
    }

    let enabled = true;
    for (const location of path.slice(1)) {
      if (location.codEnabledOverride !== null) {
        enabled = location.codEnabledOverride;
      }
    }
    if (!enabled) {
      throw new ConflictException(
        'Cash on Delivery is unavailable in this district or commune. Choose ABA PayWay.',
      );
    }
    return path;
  }

  async isCodEligible(pcode: string): Promise<boolean> {
    const path = await this.locationsRepository.findPath(pcode);
    if (path === null || path[0].codEnabledOverride !== true) {
      return false;
    }
    return path
      .slice(1)
      .reduce(
        (enabled, location) =>
          location.codEnabledOverride === null
            ? enabled
            : location.codEnabledOverride,
        true,
      );
  }
}
