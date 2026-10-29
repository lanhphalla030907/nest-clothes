import { Module } from '@nestjs/common';
import { ShippingProvidersController } from './shipping-providers.controller.js';
import { ShippingProvidersRepository } from './repositories/shipping-providers.repository.js';
import { ShippingProvidersService } from './shipping-providers.service.js';

@Module({
  controllers: [ShippingProvidersController],
  providers: [ShippingProvidersService, ShippingProvidersRepository],
  exports: [ShippingProvidersService, ShippingProvidersRepository],
})
export class ShippingProvidersModule {}
