import { toMoneyString } from '../../common/utils/money.js';
import type { ShippingProvider } from '../../generated/prisma/client.js';

export class PublicShippingProviderResponseDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  baseFee: string;
  supportsCod: boolean;

  static fromEntity(
    provider: ShippingProvider,
  ): PublicShippingProviderResponseDto {
    const dto = new PublicShippingProviderResponseDto();
    dto.id = provider.id;
    dto.code = provider.code;
    dto.name = provider.name;
    dto.description = provider.description;
    dto.baseFee = toMoneyString(provider.baseFee);
    dto.supportsCod = provider.supportsCod;
    return dto;
  }
}
