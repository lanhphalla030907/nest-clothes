import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../auth/guards/roles.guard.js';
import { AdministrativeLocationsService } from '../../locations/administrative-locations.service.js';
import { AdminCodEligibilityResponseDto } from '../../locations/dto/admin-cod-eligibility-response.dto.js';
import { ListAdministrativeLocationsQueryDto } from '../../locations/dto/list-administrative-locations-query.dto.js';
import { UpdateCodEligibilityDto } from '../../locations/dto/update-cod-eligibility.dto.js';
import { Role } from '../../generated/prisma/enums.js';

@Controller('admin/cod-eligibility')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminCodEligibilityController {
  constructor(
    private readonly locationsService: AdministrativeLocationsService,
  ) {}

  @Get()
  list(
    @Query() query: ListAdministrativeLocationsQueryDto,
  ): Promise<AdminCodEligibilityResponseDto[]> {
    return this.locationsService.listCodEligibility(query.parentPcode);
  }

  @Patch(':pcode')
  update(
    @Param('pcode') pcode: string,
    @Body() dto: UpdateCodEligibilityDto,
  ): Promise<AdminCodEligibilityResponseDto> {
    return this.locationsService.updateCodEligibility(pcode, dto);
  }
}
