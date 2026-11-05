import { IsBoolean } from 'class-validator';

export class UpdateCollectionStatusDto {
  @IsBoolean()
  isActive: boolean;
}
