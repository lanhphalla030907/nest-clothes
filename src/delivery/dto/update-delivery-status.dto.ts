import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { DeliveryStatus } from '../../generated/prisma/enums.js';

export class UpdateDeliveryStatusDto {
  @IsEnum(DeliveryStatus)
  status!: DeliveryStatus;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
