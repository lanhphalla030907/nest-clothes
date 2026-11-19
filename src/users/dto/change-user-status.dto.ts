import { IsIn } from 'class-validator';
import {
  MANAGEABLE_USER_STATUSES,
  type ManageableUserStatus,
} from '../../common/constants/user-status.constants.js';

/** Explicit account access state; deliberately independent of a user's role. */
export class ChangeUserStatusDto {
  @IsIn(MANAGEABLE_USER_STATUSES)
  status: ManageableUserStatus;
}
