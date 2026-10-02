import { UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { UserResponseDto } from '../users/dto/user-response.dto.js';
import { UsersRepository } from '../users/repositories/users.repository.js';
import { AuthService } from './auth.service.js';
import { LoginDto } from './dto/login.dto.js';
import { PasswordService } from './password/password.service.js';

const VALID_EMAIL = 'ada.lovelace@example.com';
const OTHER_EMAIL = 'grace.hopper@example.com';
const VALID_PASSWORD = 'Str0ng!Passw0rd';
const WRONG_PASSWORD = 'Wr0ng!Passw0rd';

const buildLoginDto = (overrides: Partial<LoginDto> = {}): LoginDto =>
  Object.assign(new LoginDto(), {
    email: VALID_EMAIL,
    password: VALID_PASSWORD,
    ...overrides,
  });

const buildUser = (overrides: Record<string, unknown> = {}) => ({
  id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: VALID_EMAIL,
  passwordHash: '',
  phone: null,
  status: 'ACTIVE',
  emailVerifiedAt: null,
  lastLoginAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

describe('AuthService', () => {
  let service: AuthService;
  let passwordService: PasswordService;
  let findByEmail: ReturnType<typeof vi.fn>;
  let updateLastLoginAt: ReturnType<typeof vi.fn>;
  let passwordHash: string;

  beforeEach(async () => {
    findByEmail = vi.fn();
    updateLastLoginAt = vi.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        PasswordService,
        {
          provide: UsersRepository,
          useValue: { findByEmail, updateLastLoginAt },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    passwordService = module.get<PasswordService>(PasswordService);

    passwordHash = await passwordService.hash(VALID_PASSWORD);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('authenticates a valid user and returns a sanitised response', async () => {
    const user = buildUser({ passwordHash });
    const loggedInAt = new Date('2026-02-02T10:00:00.000Z');
    findByEmail.mockResolvedValue(user);
    updateLastLoginAt.mockResolvedValue(
      buildUser({ passwordHash, lastLoginAt: loggedInAt }),
    );

    const result = await service.login(buildLoginDto());

    expect(result).toBeInstanceOf(UserResponseDto);
    expect(result.id).toBe(user.id);
    expect(result.email).toBe(VALID_EMAIL);
    expect(result.lastLoginAt).toEqual(loggedInAt);
    expect(updateLastLoginAt).toHaveBeenCalledTimes(1);
    expect(updateLastLoginAt).toHaveBeenCalledWith(user.id, expect.any(Date));
  });

  it('looks the user up by the normalised email', async () => {
    findByEmail.mockResolvedValue(buildUser({ passwordHash }));
    updateLastLoginAt.mockResolvedValue(buildUser({ passwordHash }));

    await service.login(buildLoginDto({ email: '  Ada.Lovelace@EXAMPLE.com  ' }));

    expect(findByEmail).toHaveBeenCalledWith(VALID_EMAIL);
  });

  it('rejects a wrong password with 401 and does not update lastLoginAt', async () => {
    findByEmail.mockResolvedValue(buildUser({ passwordHash }));

    await expect(
      service.login(buildLoginDto({ password: WRONG_PASSWORD })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(updateLastLoginAt).not.toHaveBeenCalled();
  });

  it('rejects an unknown email with the same 401 as a wrong password', async () => {
    findByEmail.mockResolvedValue(null);

    const unknownEmail = await service
      .login(buildLoginDto({ email: OTHER_EMAIL }))
      .catch((error: unknown) => error);
    findByEmail.mockResolvedValue(buildUser({ passwordHash }));
    const wrongPassword = await service
      .login(buildLoginDto({ password: WRONG_PASSWORD }))
      .catch((error: unknown) => error);

    expect(unknownEmail).toBeInstanceOf(UnauthorizedException);
    expect(wrongPassword).toBeInstanceOf(UnauthorizedException);
    expect((unknownEmail as UnauthorizedException).getStatus()).toBe(401);
    expect((unknownEmail as Error).message).toBe(
      (wrongPassword as Error).message,
    );
    expect((unknownEmail as Error).message).toBe(
      'Invalid email or password',
    );
    expect(updateLastLoginAt).not.toHaveBeenCalled();
  });

  it.each([
    ['SUSPENDED', 'SUSPENDED'],
    ['INACTIVE', 'INACTIVE'],
    ['DELETED', 'DELETED'],
    ['lower case active', 'active'],
  ])(
    'rejects a %s user with 401 and does not update lastLoginAt',
    async (_label, status) => {
      findByEmail.mockResolvedValue(buildUser({ passwordHash, status }));

      await expect(
        service.login(buildLoginDto()),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(updateLastLoginAt).not.toHaveBeenCalled();
    },
  );

  it('updates lastLoginAt only after the credentials are verified', async () => {
    const order: string[] = [];
    findByEmail.mockImplementation(async () => {
      order.push('findByEmail');
      return buildUser({ passwordHash });
    });
    updateLastLoginAt.mockImplementation(async () => {
      order.push('updateLastLoginAt');
      return buildUser({ passwordHash });
    });

    await service.login(buildLoginDto());

    expect(order).toEqual(['findByEmail', 'updateLastLoginAt']);
  });

  it('never exposes passwordHash or the supplied password', async () => {
    findByEmail.mockResolvedValue(buildUser({ passwordHash }));
    updateLastLoginAt.mockResolvedValue(buildUser({ passwordHash }));

    const result = await service.login(buildLoginDto());

    expect(result).not.toHaveProperty('passwordHash');
    expect(Object.keys(result)).not.toContain('passwordHash');

    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('passwordHash');
    expect(serialised).not.toContain('$argon2id$');
    expect(serialised).not.toContain(VALID_PASSWORD);
    expect(serialised).not.toContain(passwordHash);
  });

  it('does not swallow repository failures while looking the user up', async () => {
    const failure = new Error('connection terminated unexpectedly');
    findByEmail.mockRejectedValue(failure);

    await expect(service.login(buildLoginDto())).rejects.toBe(failure);
    expect(updateLastLoginAt).not.toHaveBeenCalled();
  });

  it('does not swallow repository failures while updating lastLoginAt', async () => {
    findByEmail.mockResolvedValue(buildUser({ passwordHash }));
    const failure = new Error('deadlock detected');
    updateLastLoginAt.mockRejectedValue(failure);

    await expect(service.login(buildLoginDto())).rejects.toBe(failure);
  });
});
