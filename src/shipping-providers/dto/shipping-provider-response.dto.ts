import { toMoneyString } from '../../common/utils/money.js';
import type { ShippingProvider } from '../../generated/prisma/client.js';

export class ShippingProviderResponseDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  baseFee: string;
  isActive: boolean;
  supportsCod: boolean;
  createdAt: Date;
  updatedAt: Date;

  static fromEntity(
    provider: ShippingProvider,
  ): ShippingProviderResponseDto {
    const dto = new ShippingProviderResponseDto();

    dto.id = provider.id;
    dto.code = provider.code;
    dto.name = provider.name;
    dto.description = provider.description;
    dto.baseFee = toMoneyString(provider.baseFee);
    dto.isActive = provider.isActive;
    dto.supportsCod = provider.supportsCod;
    dto.createdAt = provider.createdAt;
    dto.updatedAt = provider.updatedAt;
    return dto;
  }
}
