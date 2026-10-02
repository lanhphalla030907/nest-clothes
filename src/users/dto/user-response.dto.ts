import type { User } from '../../generated/prisma/client.js';

/**
 * Outbound representation of a user.
 *
 * `passwordHash` is deliberately absent so that it can never be serialised
 * into an API response. Users must always be mapped through this DTO.
 */
export class UserResponseDto {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  status: string;
  emailVerifiedAt: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;

  static fromEntity(user: User): UserResponseDto {
    const dto = new UserResponseDto();

    dto.id = user.id;
    dto.firstName = user.firstName;
    dto.lastName = user.lastName;
    dto.email = user.email;
    dto.phone = user.phone;
    dto.status = user.status; 
    dto.emailVerifiedAt = user.emailVerifiedAt;
    dto.lastLoginAt = user.lastLoginAt;
    dto.createdAt = user.createdAt;
    dto.updatedAt = user.updatedAt;
    return dto;
  }
}