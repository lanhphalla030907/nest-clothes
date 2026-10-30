import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { Role } from '../generated/prisma/enums.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.js';
import { DeliveryService } from './delivery.service.js';
import { AssignDeliveryDto } from './dto/assign-delivery.dto.js';
import { ReassignDeliveryDto } from './dto/reassign-delivery.dto.js';
import { DeliveryQueryDto } from './dto/delivery-query.dto.js';

@Controller('delivery/manager')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.DELIVERY_MANAGER)
export class DeliveryManagerController {
  constructor(private readonly deliveryService: DeliveryService) {}

  @Get('orders')
  listDeliveryOrders(@Query() query: DeliveryQueryDto) {
    return this.deliveryService.listDeliveryOrders(query);
  }

  @Get('orders/:orderId')
  getOrderDeliveryDetails(@Param('orderId', ParseUUIDPipe) orderId: string) {
    return this.deliveryService.getOrderDeliveryDetails(orderId);
  }

  @Post('assign')
  assignDelivery(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AssignDeliveryDto,
  ) {
    return this.deliveryService.assignDelivery(user.id, dto);
  }

  @Post('orders/:orderId/reassign')
  reassignDelivery(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: ReassignDeliveryDto,
  ) {
    return this.deliveryService.reassignDelivery(user.id, orderId, dto);
  }
}
