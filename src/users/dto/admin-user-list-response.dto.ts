import { UserResponseDto } from './user-response.dto.js';

export class AdminUserPaginationDto {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/** One server-side page of users, with totals for the same filters. */
export class AdminUserListResponseDto {
  items: UserResponseDto[];
  pagination: AdminUserPaginationDto;

  static fromResult(
    result: { items: UserResponseDto[]; total: number },
    page: number,
    limit: number,
  ): AdminUserListResponseDto {
    const dto = new AdminUserListResponseDto();
    dto.items = result.items;
    dto.pagination = {
      page,
      limit,
      total: result.total,
      totalPages: Math.ceil(result.total / limit),
    };
    return dto;
  }
}
