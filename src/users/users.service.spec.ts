import { ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PasswordService } from '../auth/password/password.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { CreateUserDto } from './dto/create-user.dto.js';
import { UserResponseDto } from './dto/user-response.dto.js';
import { UsersRepository } from './repositories/users.repository.js';
import { UsersService } from './users.service.js';

const PLAINTEXT_PASSWORD = 'Str0ng!Passw0rd';

const buildDto = (overrides: Partial<CreateUserDto> = {}): CreateUserDto =>
  Object.assign(new CreateUserDto(), {
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'Ada.Lovelace@Example.com',
    password: PLAINTEXT_PASSWORD,
    ...overrides,
  });

const buildUser = (data: {
  id: string;
  email: string;
  passwordHash: string;
}) => ({
  id: data.id,
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: data.email,
  passwordHash: data.passwordHash,
  phone: null,
  status: 'ACTIVE',
  emailVerifiedAt: null,
  lastLoginAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
});

const buildUniqueViolation = (code = 'P2002') =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code,
    clientVersion: '7.10.0',
    meta: {
      modelName: 'User',
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          originalCode: '23505',
          kind: 'UniqueConstraintViolation',
          constraint: { index: 'users_email_key' },
          table: 'users',
        },
      },
    },
  });

describe('UsersService', () => {
  let service: UsersService;
  let passwordService: PasswordService;
  let repositoryCreate: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    repositoryCreate = vi.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        PasswordService,
        {
          provide: UsersRepository,
          useValue: { create: repositoryCreate },
        },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
    passwordService = module.get<PasswordService>(PasswordService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('persists an Argon2id hash instead of the plaintext password', async () => {
    const dto = buildDto();
    repositoryCreate.mockImplementation(
      (data: { email: string; passwordHash: string }) =>
        Promise.resolve(buildUser({ id: 'user-1', ...data })),
    );

    await service.create(dto);

    const persisted = repositoryCreate.mock.calls[0][0];

    expect(persisted.passwordHash).not.toBe(dto.password);
    expect(persisted.passwordHash.startsWith('$argon2id$')).toBe(true);
    await expect(
      passwordService.verify(persisted.passwordHash, dto.password),
    ).resolves.toBe(true);
  });

  it('never passes the plaintext password to the repository', async () => {
    const dto = buildDto();
    repositoryCreate.mockImplementation(
      (data: { email: string; passwordHash: string }) =>
        Promise.resolve(buildUser({ id: 'user-1', ...data })),
    );

    await service.create(dto);

    expect(JSON.stringify(repositoryCreate.mock.calls[0][0])).not.toContain(
      PLAINTEXT_PASSWORD,
    );
  });

  it('normalises the email before persistence', async () => {
    const dto = buildDto({ email: '  Ada.Lovelace@Example.COM  ' });
    repositoryCreate.mockImplementation(
      (data: { email: string; passwordHash: string }) =>
        Promise.resolve(buildUser({ id: 'user-1', ...data })),
    );

    const result = await service.create(dto);

    expect(repositoryCreate.mock.calls[0][0].email).toBe(
      'ada.lovelace@example.com',
    );
    expect(result.email).toBe('ada.lovelace@example.com');
  });

  it('never exposes passwordHash in the returned payload', async () => {
    repositoryCreate.mockImplementation(
      (data: { email: string; passwordHash: string }) =>
        Promise.resolve(buildUser({ id: 'user-1', ...data })),
    );

    const result = await service.create(buildDto());

    expect(result).toBeInstanceOf(UserResponseDto);
    expect(result).not.toHaveProperty('passwordHash');
    expect(Object.keys(result)).not.toContain('passwordHash');
    expect(JSON.stringify(result)).not.toContain('$argon2id$');
  });

  it('defaults status to ACTIVE and omits an absent phone', async () => {
    repositoryCreate.mockImplementation(
      (data: { email: string; passwordHash: string }) =>
        Promise.resolve(buildUser({ id: 'user-1', ...data })),
    );

    await service.create(buildDto());

    const persisted = repositoryCreate.mock.calls[0][0];
    expect(persisted.status).toBe('ACTIVE');
    expect(persisted.phone).toBeUndefined();
  });

  it('throws ConflictException when the email already exists', async () => {
    repositoryCreate.mockRejectedValue(buildUniqueViolation());

    await expect(service.create(buildDto())).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(service.create(buildDto())).rejects.toThrow(
      'A user with this email already exists',
    );
  });

  it('detects the violation when Prisma reports an explicit target', async () => {
    repositoryCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '7.10.0',
        meta: { target: ['email'] },
      }),
    );

    await expect(service.create(buildDto())).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('rethrows unrelated database errors untouched', async () => {
    const failure = new Prisma.PrismaClientKnownRequestError(
      'Foreign key constraint failed',
      {
        code: 'P2003',
        clientVersion: '7.10.0',
        meta: { modelName: 'User' },
      },
    );
    repositoryCreate.mockRejectedValue(failure);

    await expect(service.create(buildDto())).rejects.toBe(failure);
  });

  it('rethrows non-Prisma errors untouched', async () => {
    const failure = new Error('connection lost');
    repositoryCreate.mockRejectedValue(failure);

    await expect(service.create(buildDto())).rejects.toBe(failure);
  });
});
