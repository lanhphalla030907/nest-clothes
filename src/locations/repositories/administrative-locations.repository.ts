import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import type { AdministrativeLocation } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

export type LocationTransactionClient = Prisma.TransactionClient;
type LocationClient = PrismaService | LocationTransactionClient;

@Injectable()
export class AdministrativeLocationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  listChildren(
    parentPcode: string | null,
    client: LocationClient = this.prisma,
  ): Promise<AdministrativeLocation[]> {
    return client.administrativeLocation.findMany({
      where: { parentPcode },
      orderBy: [{ nameEn: 'asc' }, { pcode: 'asc' }],
    });
  }

  findByPcode(
    pcode: string,
    client: LocationClient = this.prisma,
  ): Promise<AdministrativeLocation | null> {
    return client.administrativeLocation.findUnique({ where: { pcode } });
  }

  async findPath(
    pcode: string,
    client: LocationClient = this.prisma,
    lockForShare = false,
  ): Promise<AdministrativeLocation[] | null> {
    const path: AdministrativeLocation[] = [];
    let current = await this.findByPcode(pcode, client);

    if (current === null) return null;

    while (current !== null) {
      path.push(current);
      current =
        current.parentPcode === null
          ? null
          : await this.findByPcode(current.parentPcode, client);
    }

    if (lockForShare) {
      const pcodes = path.map((location) => location.pcode);
      await client.$queryRaw`
        SELECT "pcode" FROM "administrative_locations"
        WHERE "pcode" IN (${Prisma.join(pcodes)})
        FOR SHARE
      `;
      for (let index = 0; index < path.length; index += 1) {
        const refreshed = await this.findByPcode(path[index].pcode, client);
        if (refreshed === null) return null;
        path[index] = refreshed;
      }
    }

    return path.reverse();
  }

  async hasCodOverridesBelow(
    provincePcode: string,
    client: LocationTransactionClient,
  ): Promise<boolean> {
    // Lock unset rules too, so an admin cannot add an override mid-checkout.
    const descendants = await client.$queryRaw<
      Array<{ cod_enabled_override: boolean | null }>
    >`
      WITH RECURSIVE descendants(pcode) AS (
        SELECT "pcode"
        FROM "administrative_locations"
        WHERE "parent_pcode" = ${provincePcode}
        UNION ALL
        SELECT child."pcode"
        FROM "administrative_locations" child
        INNER JOIN descendants parent ON child."parent_pcode" = parent."pcode"
      )
      SELECT location."cod_enabled_override"
      FROM "administrative_locations" location
      INNER JOIN descendants ON descendants.pcode = location."pcode"
      FOR SHARE OF location
    `;
    return descendants.some((location) => location.cod_enabled_override !== null);
  }

  updateCodOverride(
    pcode: string,
    codEnabledOverride: boolean | null,
  ): Promise<AdministrativeLocation> {
    return this.prisma.administrativeLocation.update({
      where: { pcode },
      data: { codEnabledOverride },
    });
  }
}
