import { InternalServerErrorException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';

export interface ShippingLocationSnapshotEntry {
  adminLevel: 1 | 2 | 3;
  nameEn: string;
  nameKm: string | null;
}

export const toShippingLocationPath = (
  value: Prisma.JsonValue | null,
): ShippingLocationSnapshotEntry[] | null => {
  if (value === null) return null;
  if (!Array.isArray(value)) {
    throw new InternalServerErrorException(
      'The order shipping location snapshot is invalid',
    );
  }

  return value.map((entry) => {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      (entry['adminLevel'] !== 1 &&
        entry['adminLevel'] !== 2 &&
        entry['adminLevel'] !== 3) ||
      typeof entry['nameEn'] !== 'string' ||
      (typeof entry['nameKm'] !== 'string' && entry['nameKm'] !== null)
    ) {
      throw new InternalServerErrorException(
        'The order shipping location snapshot is invalid',
      );
    }

    return {
      adminLevel: entry['adminLevel'],
      nameEn: entry['nameEn'],
      nameKm: entry['nameKm'],
    };
  });
};
