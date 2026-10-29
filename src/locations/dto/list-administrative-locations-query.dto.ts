import { IsOptional, Matches } from 'class-validator';

const ADMIN_LOCATION_PCODE_PATTERN = /^KH(?:[0-9]{2}){1,3}$/;

export class ListAdministrativeLocationsQueryDto {
  @IsOptional()
  @Matches(ADMIN_LOCATION_PCODE_PATTERN, {
    message: 'parentPcode must be a Cambodia administrative P-code',
  })
  parentPcode?: string;
}
