import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PasswordService } from '../auth/password/password.service.js';
import { ASSIGNABLE_ROLES } from '../common/constants/assignable-roles.constants.js';
import {
  ACTIVE_USER_STATUS,
  type ManageableUserStatus,
} from '../common/constants/user-status.constants.js';
import { normalizeEmail } from '../common/utils/normalize-email.js';
import { Prisma } from '../generated/prisma/client.js';
import { Role } from '../generated/prisma/enums.js';
import { CreateUserDto } from './dto/create-user.dto.js';
import { AdminUserListQueryDto } from './dto/admin-user-list-query.dto.js';
import { AdminUserListResponseDto } from './dto/admin-user-list-response.dto.js';
import { UserResponseDto } from './dto/user-response.dto.js';
import { UsersRepository } from './repositories/users.repository.js';
import { RefreshSessionRepository } from '../auth/refresh/refresh-session.repository.js';

const PRISMA_UNIQUE_CONSTRAINT_VIOLATION = 'P2002';
const USER_MODEL = 'User';
const EMAIL_FIELD = 'email';

@Injectable()
export class UsersService {
  constructor(
    private readonly usersRepository: UsersRepository,
    private readonly passwordService: PasswordService,
    private readonly refreshSessions: RefreshSessionRepository,
  ) {}

  async create(dto: CreateUserDto): Promise<UserResponseDto> {
    return this.createWithRole(dto, Role.CUSTOMER);
  }

  createDeliveryStaff(dto: CreateUserDto): Promise<UserResponseDto> {
    return this.createWithRole(dto, Role.DELIVERY_STAFF);
  }

  private async createWithRole(
    dto: CreateUserDto,
    role: Role,
  ): Promise<UserResponseDto> {
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
        role,
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
   * All users for the administrative role-management table.
   *
   * Every row is mapped through `UserResponseDto`, so this read can never leak a
   * password hash or any other authentication material.
   */
  async findAll(): Promise<UserResponseDto[]> {
    const users = await this.usersRepository.findAll();
    return users.map((user) => UserResponseDto.fromEntity(user));
  }

  async findPage(
    query: AdminUserListQueryDto,
  ): Promise<AdminUserListResponseDto> {
    const result = await this.usersRepository.findAdminPage(query);
    return AdminUserListResponseDto.fromResult(
      {
        items: result.items.map((user) => UserResponseDto.fromEntity(user)),
        total: result.total,
      },
      query.page,
      query.limit,
    );
  }

  /**
   * Changes one user's role and records who did it, when, and what changed.
   *
   * Only an administrator can reach this method (the route is guarded), but the
   * rules live here so they hold no matter which caller invokes the service:
   * no self-change, no unassignable role, no unknown target, and no demotion of
   * the last active administrator. The read, write and audit insert are atomic.
   */
  async changeRole(
    actorId: string,
    targetId: string,
    newRole: Role,
  ): Promise<UserResponseDto> {
    if (!ASSIGNABLE_ROLES.includes(newRole)) {
      throw new BadRequestException('That role cannot be assigned here');
    }

    if (actorId === targetId) {
      throw new ForbiddenException('You cannot change your own role');
    }

    return this.usersRepository.runInTransaction(async (tx) => {
      const target = await this.usersRepository.findById(targetId, tx);
      if (target === null) {
        throw new NotFoundException('User does not exist');
      }

      if (target.role === newRole) {
        return UserResponseDto.fromEntity(target);
      }

      if (
        target.role === Role.ADMIN &&
        newRole !== Role.ADMIN &&
        target.status === ACTIVE_USER_STATUS
      ) {
        const activeAdmins = await this.usersRepository.countActiveAdmins(tx);
        if (activeAdmins <= 1) {
          throw new ConflictException('The last active administrator cannot be demoted');
        }
      }

      const updated = await this.usersRepository.updateRole(targetId, newRole, tx);

      await this.usersRepository.recordRoleChange(
        {
          actorId,
          targetUserId: targetId,
          previousRole: target.role,
          newRole,
        },
        tx,
      );
      await this.refreshSessions.revokeUserSessions(
        targetId,
        new Date(),
        'role_change',
        tx,
      );

      return UserResponseDto.fromEntity(updated);
    });
  }

  /** Changes account access while retaining the role and every related record. */
  async changeStatus(
    actorId: string,
    targetId: string,
    status: ManageableUserStatus,
  ): Promise<UserResponseDto> {
    if (actorId === targetId) {
      throw new ForbiddenException('You cannot change your own account status');
    }

    return this.usersRepository.runInTransaction(async (tx) => {
      const target = await this.usersRepository.findById(targetId, tx);
      if (target === null) {
        throw new NotFoundException('User does not exist');
      }
      if (target.status === status) {
        return UserResponseDto.fromEntity(target);
      }

      if (
        target.role === Role.ADMIN &&
        target.status === ACTIVE_USER_STATUS &&
        status !== ACTIVE_USER_STATUS
      ) {
        const activeAdmins = await this.usersRepository.countActiveAdmins(tx);
        if (activeAdmins <= 1) {
          throw new ConflictException('The last active administrator cannot be deactivated');
        }
      }

      const updated = await this.usersRepository.updateStatus(targetId, status, tx);
      if (status !== ACTIVE_USER_STATUS) {
        await this.refreshSessions.revokeUserSessions(
          targetId,
          new Date(),
          'account_deactivated',
          tx,
        );
      }
      return UserResponseDto.fromEntity(updated);
    });
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
