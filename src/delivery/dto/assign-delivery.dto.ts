import { IsNotEmpty, IsUUID } from 'class-validator';

export class AssignDeliveryDto {
  @IsNotEmpty()
  @IsUUID()
  orderId!: string;

  @IsNotEmpty()
  @IsUUID()
  deliveryStaffId!: string;
}
