import { Module } from '@nestjs/common';
import { AdministrativeLocationsController } from './administrative-locations.controller.js';
import { AdministrativeLocationsService } from './administrative-locations.service.js';
import { AdministrativeLocationsRepository } from './repositories/administrative-locations.repository.js';

@Module({
  controllers: [AdministrativeLocationsController],
  providers: [
    AdministrativeLocationsService,
    AdministrativeLocationsRepository,
  ],
  exports: [
    AdministrativeLocationsService,
    AdministrativeLocationsRepository,
  ],
})
export class LocationsModule {}
