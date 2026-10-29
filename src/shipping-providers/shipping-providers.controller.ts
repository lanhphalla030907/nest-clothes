import { Controller, Get } from '@nestjs/common';
import { PublicShippingProviderResponseDto } from './dto/public-shipping-provider-response.dto.js';
import { ShippingProvidersService } from './shipping-providers.service.js';

@Controller('shipping/providers')
export class ShippingProvidersController {
  constructor(
    private readonly shippingProvidersService: ShippingProvidersService,
  ) {}

  @Get()
  async findActive(): Promise<PublicShippingProviderResponseDto[]> {
    const providers = await this.shippingProvidersService.listActive();
    return providers.map(PublicShippingProviderResponseDto.fromEntity);
  }
}
