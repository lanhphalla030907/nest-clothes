import { Module } from '@nestjs/common';
import { CodAreasController } from './cod-areas.controller.js';
import { CodAreasRepository } from './repositories/cod-areas.repository.js';
import { CodAreasService } from './cod-areas.service.js';

@Module({
  controllers: [CodAreasController],
  providers: [CodAreasService, CodAreasRepository],
  exports: [CodAreasService, CodAreasRepository],
})
export class CodAreasModule {}
