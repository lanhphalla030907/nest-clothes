import { Controller, Get, Query } from '@nestjs/common';
import { AdministrativeLocationsService } from './administrative-locations.service.js';
import { ListAdministrativeLocationsQueryDto } from './dto/list-administrative-locations-query.dto.js';
import { AdministrativeLocationResponseDto } from './dto/administrative-location-response.dto.js';

@Controller('locations')
export class AdministrativeLocationsController {
  constructor(
    private readonly locationsService: AdministrativeLocationsService,
  ) {}

  @Get('cambodia')
  listCambodia(
    @Query() query: ListAdministrativeLocationsQueryDto,
  ): Promise<AdministrativeLocationResponseDto[]> {
    return this.locationsService.listChildren(query.parentPcode);
  }
}
