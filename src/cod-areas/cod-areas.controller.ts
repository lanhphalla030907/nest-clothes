import { Controller, Get } from '@nestjs/common';
import { CodAreasService } from './cod-areas.service.js';
import { PublicCodAreaResponseDto } from './dto/public-cod-area-response.dto.js';

@Controller('cod-areas')
export class CodAreasController {
  constructor(private readonly codAreasService: CodAreasService) {}

  @Get()
  findCodEnabled(): Promise<PublicCodAreaResponseDto[]> {
    return this.codAreasService.listCodEnabled();
  }
}
