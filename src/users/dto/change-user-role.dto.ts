import { IsEnum, IsIn } from 'class-validator';
import { ASSIGNABLE_ROLES } from '../../common/constants/assignable-roles.constants.js';
import { Role } from '../../generated/prisma/enums.js';

/**
 * `PATCH /admin/users/:id/role` accepts only a role from the allow-list.
 *
 * `CUSTOMER` is shown as "USER" in the dashboard; it is the existing base role and
 * no schema change is needed for that label.
 */
export class ChangeUserRoleDto {
  @IsEnum(Role)
  @IsIn(ASSIGNABLE_ROLES)
  role: Role;
}
