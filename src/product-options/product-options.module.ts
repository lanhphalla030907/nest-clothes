import { Module } from '@nestjs/common';
import { ProductOptionsService } from './product-options.service.js';

@Module({
  providers: [ProductOptionsService],
  exports: [ProductOptionsService],
})
export class ProductOptionsModule {}
