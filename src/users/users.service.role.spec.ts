import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PasswordService } from '../auth/password/password.service.js';
import type { User } from '../generated/prisma/client.js';
import { Role } from '../generated/prisma/enums.js';
import { UsersRepository } from './repositories/users.repository.js';
import { RefreshSessionRepository } from '../auth/refresh/refresh-session.repository.js';
import { UsersService } from './users.service.js';

const ADMIN_ID = 'a1b2c3d4-e5f6-4f70-8a9b-0c1d2e3f4a5b';
const TARGET_ID = 'b2c3d4e5-f6a7-4b81-9c0d-1e2f3a4b5c6d';

const buildUser = (overrides: Partial<User> = {}): User => ({
  id: TARGET_ID,
  firstName: 'Grace',
  lastName: 'Hopper',
  email: 'grace@example.test',
  passwordHash: 'must-never-leak',
  phone: null,
  status: 'ACTIVE',
  role: Role.CUSTOMER,
  emailVerifiedAt: null,
  lastLoginAt: null,
  passwordChangedAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

/**
 * These tests exercise the rules that must hold even if a future route forgets a
 * guard: the authorisation decisions live in `UsersService.changeRole`, not in the
 * controller, and the audit record is written in the same transaction as the update.
 */
describe('UsersService.changeRole', () => {
  let service: UsersService;
  const tx = { marker: 'transaction-client' };
  const repository = {
    findAll: vi.fn(),
    findAdminPage: vi.fn(),
    findById: vi.fn(),
    countActiveAdmins: vi.fn(),
    updateRole: vi.fn(),
    updateStatus: vi.fn(),
    recordRoleChange: vi.fn(),
    runInTransaction: vi.fn(),
  };
  const refreshSessions = {
    revokeUserSessions: vi.fn(),
  };

  beforeEach(async () => {
    vi.resetAllMocks();
    repository.runInTransaction.mockImplementation(async (work) => work(tx));
    refreshSessions.revokeUserSessions.mockResolvedValue(1);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: UsersRepository, useValue: repository },
        { provide: PasswordService, useValue: { hash: vi.fn() } },
        { provide: RefreshSessionRepository, useValue: refreshSessions },
      ],
    }).compile();

    service = module.get(UsersService);
  });

  it('promotes a user to ADMIN and records the actor, previous role and new role', async () => {
    const target = buildUser();
    repository.findById.mockResolvedValue(target);
    repository.updateRole.mockResolvedValue({ ...target, role: Role.ADMIN });

    const result = await service.changeRole(ADMIN_ID, TARGET_ID, Role.ADMIN);

    expect(result).toMatchObject({ id: TARGET_ID, role: Role.ADMIN });
    expect(result).not.toHaveProperty('passwordHash');
    expect(repository.updateRole).toHaveBeenCalledWith(TARGET_ID, Role.ADMIN, tx);
    expect(repository.recordRoleChange).toHaveBeenCalledWith(
      {
        actorId: ADMIN_ID,
        targetUserId: TARGET_ID,
        previousRole: Role.CUSTOMER,
        newRole: Role.ADMIN,
      },
      tx,
    );
    expect(refreshSessions.revokeUserSessions).toHaveBeenCalledWith(
      TARGET_ID,
      expect.any(Date),
      'role_change',
      tx,
    );
  });

  it('never lets a caller change their own role', async () => {
    await expect(
      service.changeRole(ADMIN_ID, ADMIN_ID, Role.CUSTOMER),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(repository.runInTransaction).not.toHaveBeenCalled();
    expect(repository.updateRole).not.toHaveBeenCalled();
    expect(repository.recordRoleChange).not.toHaveBeenCalled();
  });

  it('rejects an unknown target user', async () => {
    repository.findById.mockResolvedValue(null);

    await expect(
      service.changeRole(ADMIN_ID, TARGET_ID, Role.ADMIN),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(repository.updateRole).not.toHaveBeenCalled();
    expect(repository.recordRoleChange).not.toHaveBeenCalled();
  });

  it('refuses to demote the last active administrator', async () => {
    repository.findById.mockResolvedValue(
      buildUser({ role: Role.ADMIN, status: 'ACTIVE' }),
    );
    repository.countActiveAdmins.mockResolvedValue(1);

    await expect(
      service.changeRole(ADMIN_ID, TARGET_ID, Role.CUSTOMER),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(repository.countActiveAdmins).toHaveBeenCalledWith(tx);
    expect(repository.updateRole).not.toHaveBeenCalled();
    expect(repository.recordRoleChange).not.toHaveBeenCalled();
  });

  it('allows demotion when another active administrator remains', async () => {
    const target = buildUser({ role: Role.ADMIN });
    repository.findById.mockResolvedValue(target);
    repository.countActiveAdmins.mockResolvedValue(2);
    repository.updateRole.mockResolvedValue({ ...target, role: Role.CUSTOMER });

    await expect(
      service.changeRole(ADMIN_ID, TARGET_ID, Role.CUSTOMER),
    ).resolves.toMatchObject({ role: Role.CUSTOMER });

    expect(repository.recordRoleChange).toHaveBeenCalledWith(
      expect.objectContaining({
        previousRole: Role.ADMIN,
        newRole: Role.CUSTOMER,
      }),
      tx,
    );
  });

  it('allows an inactive administrator to change role without consuming the active-admin guard', async () => {
    const target = buildUser({ role: Role.ADMIN, status: 'SUSPENDED' });
    repository.findById.mockResolvedValue(target);
    repository.countActiveAdmins.mockResolvedValue(1);
    repository.updateRole.mockResolvedValue({ ...target, role: Role.CUSTOMER });

    await expect(
      service.changeRole(ADMIN_ID, TARGET_ID, Role.CUSTOMER),
    ).resolves.toMatchObject({ role: Role.CUSTOMER });

    expect(repository.countActiveAdmins).not.toHaveBeenCalled();
    expect(repository.updateRole).toHaveBeenCalled();
  });

  it('does not write an audit row when the role is unchanged', async () => {
    const target = buildUser();
    repository.findById.mockResolvedValue(target);

    await expect(
      service.changeRole(ADMIN_ID, TARGET_ID, Role.CUSTOMER),
    ).resolves.toMatchObject({ role: Role.CUSTOMER });

    expect(repository.updateRole).not.toHaveBeenCalled();
    expect(repository.recordRoleChange).not.toHaveBeenCalled();
  });

  it('refuses a role the admin screen is not allowed to assign', async () => {
    await expect(
      service.changeRole(ADMIN_ID, TARGET_ID, Role.DELIVERY_MANAGER),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(repository.runInTransaction).not.toHaveBeenCalled();
  });

  it('maps every listed user through the safe response DTO', async () => {
    repository.findAll.mockResolvedValue([buildUser()]);

    const users = await service.findAll();

    expect(users).toEqual([expect.objectContaining({ id: TARGET_ID })]);
    expect(JSON.stringify(users)).not.toContain('passwordHash');
  });

  it('returns a bounded page and pagination metadata without exposing password hashes', async () => {
    repository.findAdminPage.mockResolvedValue({ items: [buildUser()], total: 21 });

    const result = await service.findPage({ page: 2, limit: 10 });

    expect(repository.findAdminPage).toHaveBeenCalledWith({ page: 2, limit: 10 });
    expect(result).toMatchObject({
      items: [expect.objectContaining({ id: TARGET_ID })],
      pagination: { page: 2, limit: 10, total: 21, totalPages: 3 },
    });
    expect(JSON.stringify(result)).not.toContain('passwordHash');
  });

  it('deactivates another account without changing their role', async () => {
    const target = buildUser({ role: Role.DELIVERY_STAFF, status: 'ACTIVE' });
    repository.findById.mockResolvedValue(target);
    repository.updateStatus.mockResolvedValue({ ...target, status: 'INACTIVE' });

    await expect(
      service.changeStatus(ADMIN_ID, TARGET_ID, 'INACTIVE'),
    ).resolves.toMatchObject({ role: Role.DELIVERY_STAFF, status: 'INACTIVE' });

    expect(repository.updateStatus).toHaveBeenCalledWith(TARGET_ID, 'INACTIVE', tx);
    expect(refreshSessions.revokeUserSessions).toHaveBeenCalledWith(
      TARGET_ID,
      expect.any(Date),
      'account_deactivated',
      tx,
    );
    expect(repository.updateRole).not.toHaveBeenCalled();
  });

  it('rolls back the status change if refresh-session revocation fails', async () => {
    const target = buildUser({ status: 'ACTIVE' });
    repository.findById.mockResolvedValue(target);
    repository.updateStatus.mockResolvedValue({ ...target, status: 'INACTIVE' });
    refreshSessions.revokeUserSessions.mockRejectedValue(
      new Error('session revoke failed'),
    );

    await expect(
      service.changeStatus(ADMIN_ID, TARGET_ID, 'INACTIVE'),
    ).rejects.toThrow('session revoke failed');
  });

  it('never lets an administrator deactivate their own account', async () => {
    await expect(
      service.changeStatus(ADMIN_ID, ADMIN_ID, 'INACTIVE'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.runInTransaction).not.toHaveBeenCalled();
  });

  it('refuses to deactivate the last active administrator', async () => {
    repository.findById.mockResolvedValue(buildUser({ role: Role.ADMIN }));
    repository.countActiveAdmins.mockResolvedValue(1);

    await expect(
      service.changeStatus(ADMIN_ID, TARGET_ID, 'INACTIVE'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(repository.updateStatus).not.toHaveBeenCalled();
  });
});
