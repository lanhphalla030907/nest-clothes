import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../../auth/guards/roles.guard.js';
import { Role } from '../../generated/prisma/enums.js';
import { CreateShippingProviderDto } from '../../shipping-providers/dto/create-shipping-provider.dto.js';
import { ShippingProviderResponseDto } from '../../shipping-providers/dto/shipping-provider-response.dto.js';
import { UpdateShippingProviderDto } from '../../shipping-providers/dto/update-shipping-provider.dto.js';
import { ShippingProvidersService } from '../../shipping-providers/shipping-providers.service.js';

@Controller('admin/shipping-providers')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminShippingProvidersController {
  constructor(
    private readonly shippingProvidersService: ShippingProvidersService,
  ) {}

  @Get()
  findAll(): Promise<ShippingProviderResponseDto[]> {
    return this.shippingProvidersService.listForAdmin();
  }

  @Post()
  create(
    @Body() dto: CreateShippingProviderDto,
  ): Promise<ShippingProviderResponseDto> {
    return this.shippingProvidersService.create(dto);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateShippingProviderDto,
  ): Promise<ShippingProviderResponseDto> {
    return this.shippingProvidersService.update(id, dto);
  }
}
