import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.js';
import { DeliveryService } from './delivery.service.js';
import { DELIVERY_STAFF_ROLES } from './constants/delivery-authorization.constants.js';
import { CollectCodDto } from './dto/collect-cod.dto.js';
import { UpdateDeliveryStatusDto } from './dto/update-delivery-status.dto.js';
import { DeliveryQueryDto } from './dto/delivery-query.dto.js';
import { CodReceiptUploadInterceptor } from './interceptors/cod-receipt-upload.interceptor.js';
import type { UploadedReceiptFile } from './interfaces/uploaded-receipt-file.js';

@Controller('delivery/staff')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...DELIVERY_STAFF_ROLES)
export class DeliveryStaffController {
  constructor(private readonly deliveryService: DeliveryService) {}

  @Get('assignments')
  getMyAssignments(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: DeliveryQueryDto,
  ) {
    return this.deliveryService.getMyAssignments(user.id, query);
  }

  @Get('assignments/:assignmentId')
  getMyAssignment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
  ) {
    return this.deliveryService.getMyAssignment(user.id, assignmentId);
  }

  @Patch('assignments/:assignmentId/status')
  updateMyAssignmentStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Body() dto: UpdateDeliveryStatusDto,
  ) {
    return this.deliveryService.updateMyAssignmentStatus(user.id, assignmentId, dto);
  }

  /**
   * Records the cash collected for a COD order on the caller's assignment.
   *
   * The receipt is an optional multipart file under `receiptProof`; it is
   * uploaded server-side and never accepted as a URL in the body. A request with
   * only JSON fields is valid and records the collection without a receipt.
   */
  @Post('assignments/:assignmentId/collect-cod')
  @UseInterceptors(CodReceiptUploadInterceptor)
  collectCod(
    @CurrentUser() user: AuthenticatedUser,
    @Param('assignmentId', ParseUUIDPipe) assignmentId: string,
    @Body() dto: CollectCodDto,
    @UploadedFile() receiptProof: UploadedReceiptFile | undefined,
  ) {
    return this.deliveryService.collectCod(
      user.id,
      assignmentId,
      dto,
      receiptProof,
    );
  }
}
