import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  MANAGEABLE_USER_STATUSES,
  type ManageableUserStatus,
} from '../../common/constants/user-status.constants.js';
import { Role } from '../../generated/prisma/enums.js';

/** Query contract for the bounded administrative user list. */
export class AdminUserListQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 10;

  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  @IsOptional()
  @IsIn(MANAGEABLE_USER_STATUSES)
  status?: ManageableUserStatus;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}
