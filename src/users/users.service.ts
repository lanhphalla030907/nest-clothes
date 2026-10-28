import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PasswordService } from '../auth/password/password.service.js';
import { ACTIVE_USER_STATUS } from '../common/constants/user-status.constants.js';
import { normalizeEmail } from '../common/utils/normalize-email.js';
import { Prisma } from '../generated/prisma/client.js';
import { Role } from '../generated/prisma/enums.js';
import { CreateUserDto } from './dto/create-user.dto.js';
import { UserResponseDto } from './dto/user-response.dto.js';
import { UsersRepository } from './repositories/users.repository.js';

const PRISMA_UNIQUE_CONSTRAINT_VIOLATION = 'P2002';
const USER_MODEL = 'User';
const EMAIL_FIELD = 'email';

@Injectable()
export class UsersService {
  constructor(
    private readonly usersRepository: UsersRepository,
    private readonly passwordService: PasswordService,
  ) {}

  async create(dto: CreateUserDto): Promise<UserResponseDto> {
    const email = normalizeEmail(dto.email);
    const passwordHash = await this.passwordService.hash(dto.password);

    try {
      const user = await this.usersRepository.create({
        firstName: dto.firstName,
        lastName: dto.lastName,
        email,
        passwordHash,
        phone: dto.phone,
        status: ACTIVE_USER_STATUS,
        role: Role.CUSTOMER,
      });

      return UserResponseDto.fromEntity(user);
    } catch (error) {
      if (this.isEmailUniqueViolation(error)) {
        throw new ConflictException('A user with this email already exists');
      }

      throw error;
    }
  }

  /**
   * The user with `id`, or `null` when no such user exists.
   *
   * The read is not owner-scoped, so it belongs to the administrative path only and is
   * reached exclusively through a route guarded by `@Roles(Role.ADMIN)`. There is no
   * "look up anybody" method on this service for a customer-facing route to pick up.
   */
  async findOne(id: string): Promise<UserResponseDto> {
    const user = await this.usersRepository.findById(id);

    if (!user) {
      throw new NotFoundException('User does not exist');
    }

    return UserResponseDto.fromEntity(user);
  }

  /**
   * Detects a unique constraint violation on `users.email`.
   *
   * Prisma only populates `meta.target` for engines that report it. With driver
   * adapters such as `@prisma/adapter-pg` the meta object carries only
   * `modelName` and `driverAdapterError`, so the model name is used as the
   * fallback. `email` is currently the only unique constraint on `users`; if
   * another one is added this check must be narrowed accordingly.
   */
  private isEmailUniqueViolation(error: unknown): boolean {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
      return false;
    }

    if (error.code !== PRISMA_UNIQUE_CONSTRAINT_VIOLATION) {
      return false;
    }

    const meta = error.meta;
    const target = meta?.['target'];

    if (Array.isArray(target)) {
      return target.includes(EMAIL_FIELD);
    }

    if (typeof target === 'string') {
      return target === EMAIL_FIELD;
    }

    return meta?.['modelName'] === USER_MODEL;
  }
}