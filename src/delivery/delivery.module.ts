import { Module } from '@nestjs/common';
import { JwtAuthModule } from '../auth/jwt/jwt-auth.module.js';
import { DeliveryRepository } from './repositories/delivery.repository.js';
import { DeliveryService } from './delivery.service.js';
import { DeliveryController } from './delivery.controller.js';
import { DeliveryManagerController } from './delivery-manager.controller.js';
import { DeliveryStaffController } from './delivery-staff.controller.js';

@Module({
  imports: [JwtAuthModule],
  controllers: [DeliveryController, DeliveryManagerController, DeliveryStaffController],
  providers: [DeliveryRepository, DeliveryService],
  exports: [DeliveryService],
})
export class DeliveryModule {}
