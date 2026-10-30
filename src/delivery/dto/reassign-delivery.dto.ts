import { IsNotEmpty, IsUUID } from 'class-validator';

export class ReassignDeliveryDto {
  @IsNotEmpty()
  @IsUUID()
  deliveryStaffId!: string;
}
