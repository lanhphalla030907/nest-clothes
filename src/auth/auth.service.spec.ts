import {
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  TEST_JWT_SETTINGS,
  testAccessTokenService,
} from '../../test/support/auth-fixtures.js';
import { Prisma } from '../generated/prisma/client.js';
import { Role } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UserResponseDto } from '../users/dto/user-response.dto.js';
import { UserIdentityRepository } from '../users/repositories/user-identity.repository.js';
import { UsersRepository } from '../users/repositories/users.repository.js';
import { AuthService } from './auth.service.js';
import { LoginResponseDto } from './dto/login-response.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { GoogleAuthService } from './google/google-auth.service.js';
import { AccessTokenService } from './jwt/access-token.service.js';
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
  role: Role.CUSTOMER,
  emailVerifiedAt: null,
  lastLoginAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

const makePrismaP2002Error = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint violation', {
    code: 'P2002',
    clientVersion: '7.10.0',
  });

describe('AuthService', () => {
  let service: AuthService;
  let passwordService: PasswordService;
  let accessTokenService: AccessTokenService;
  let findByEmail: ReturnType<typeof vi.fn>;
  let findById: ReturnType<typeof vi.fn>;
  let createUser: ReturnType<typeof vi.fn>;
  let updateLastLoginAt: ReturnType<typeof vi.fn>;
  let updateEmailVerifiedAt: ReturnType<typeof vi.fn>;
  let findByProviderSubject: ReturnType<typeof vi.fn>;
  let findIdentitiesByUserId: ReturnType<typeof vi.fn>;
  let createIdentity: ReturnType<typeof vi.fn>;
  let verifyGoogleToken: ReturnType<typeof vi.fn>;
  let prismaTransaction: ReturnType<typeof vi.fn>;
  let passwordHash: string;

  beforeEach(async () => {
    findByEmail = vi.fn();
    findById = vi.fn();
    createUser = vi.fn();
    updateLastLoginAt = vi.fn();
    updateEmailVerifiedAt = vi.fn();
    findByProviderSubject = vi.fn();
    findIdentitiesByUserId = vi.fn();
    createIdentity = vi.fn();
    verifyGoogleToken = vi.fn();
    prismaTransaction = vi.fn(async (cb: (tx: any) => Promise<any>) => cb({}));
    accessTokenService = testAccessTokenService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        PasswordService,
        { provide: AccessTokenService, useValue: accessTokenService },
        {
          provide: UsersRepository,
          useValue: {
            findByEmail,
            findById,
            create: createUser,
            updateLastLoginAt,
            updateEmailVerifiedAt,
          },
        },
        {
          provide: UserIdentityRepository,
          useValue: {
            findByProviderSubject,
            findIdentitiesByUserId,
            create: createIdentity,
          },
        },
        {
          provide: GoogleAuthService,
          useValue: {
            verifyToken: verifyGoogleToken,
          },
        },
        {
          provide: PrismaService,
          useValue: {
            $transaction: prismaTransaction,
          },
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

  it('authenticates a valid user and returns a token with a sanitised user', async () => {
    const user = buildUser({ passwordHash });
    const loggedInAt = new Date('2026-02-02T10:00:00.000Z');
    findByEmail.mockResolvedValue(user);
    updateLastLoginAt.mockResolvedValue(
      buildUser({ passwordHash, lastLoginAt: loggedInAt }),
    );

    const result = await service.login(buildLoginDto());

    expect(result).toBeInstanceOf(LoginResponseDto);
    expect(result.user).toBeInstanceOf(UserResponseDto);
    expect(result.user.id).toBe(user.id);
    expect(result.user.email).toBe(VALID_EMAIL);
    expect(result.user.lastLoginAt).toEqual(loggedInAt);
    expect(result.expiresIn).toBe(TEST_JWT_SETTINGS.expiresIn);
    expect(updateLastLoginAt).toHaveBeenCalledTimes(1);
    expect(updateLastLoginAt).toHaveBeenCalledWith(user.id, expect.any(Date));
  });

  it('returns a token that verifies and names the user who logged in', async () => {
    const user = buildUser({ passwordHash });
    findByEmail.mockResolvedValue(user);
    updateLastLoginAt.mockResolvedValue(user);

    const result = await service.login(buildLoginDto());
    const payload = await accessTokenService.verify(result.accessToken);

    expect(payload.sub).toBe(user.id);
    expect(payload.role).toBe(Role.CUSTOMER);
  });

  it('signs the role the database holds, not one the client could claim', async () => {
    const user = buildUser({ passwordHash, role: Role.ADMIN });
    findByEmail.mockResolvedValue(user);
    updateLastLoginAt.mockResolvedValue(user);

    const result = await service.login(buildLoginDto());

    await expect(
      accessTokenService.verify(result.accessToken),
    ).resolves.toMatchObject({ role: Role.ADMIN });
    expect(result.user.role).toBe(Role.ADMIN);
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

    expect(result.user).not.toHaveProperty('passwordHash');
    expect(Object.keys(result.user)).not.toContain('passwordHash');

    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('passwordHash');
    expect(serialised).not.toContain('$argon2id$');
    expect(serialised).not.toContain(VALID_PASSWORD);
    expect(serialised).not.toContain(passwordHash);
  });

  it('never exposes the signing secret alongside the token', async () => {
    findByEmail.mockResolvedValue(buildUser({ passwordHash }));
    updateLastLoginAt.mockResolvedValue(buildUser({ passwordHash }));

    const result = await service.login(buildLoginDto());

    expect(Object.keys(result).sort()).toEqual(
      ['accessToken', 'expiresIn', 'user'].sort(),
    );
    expect(JSON.stringify(result)).not.toContain(TEST_JWT_SETTINGS.secret);
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

  describe('currentUser', () => {
    it('returns the row as the database currently has it', async () => {
      const user = buildUser({ passwordHash, role: Role.ADMIN, status: 'ACTIVE' });
      findById.mockResolvedValue(user);

      const result = await service.currentUser(user.id);

      expect(result).toBeInstanceOf(UserResponseDto);
      expect(result.id).toBe(user.id);
      expect(result.role).toBe(Role.ADMIN);
      expect(findById).toHaveBeenCalledWith(user.id);
    });

    it('404s when the user has since been deleted', async () => {
      findById.mockResolvedValue(null);

      await expect(
        service.currentUser('3f2504e0-4f89-41d3-9a0c-0305e82c3301'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('googleLogin', () => {
    const googlePayload = {
      sub: 'google-sub-12345',
      email: VALID_EMAIL,
      emailVerified: true,
      firstName: 'Ada',
      lastName: 'Lovelace',
      picture: 'https://example.com/photo.jpg',
    };

    beforeEach(() => {
      verifyGoogleToken.mockResolvedValue(googlePayload);
    });

    it('signs in an existing user already linked via UserIdentity', async () => {
      const user = buildUser({ passwordHash });
      findByProviderSubject.mockResolvedValue({
        id: 'ident-1',
        userId: user.id,
        provider: 'google',
        providerSubject: googlePayload.sub,
        user, // nested user from include
      });
      updateLastLoginAt.mockResolvedValue(user);

      const result = await service.googleLogin({ idToken: 'valid-google-token' });

      expect(result).toBeInstanceOf(LoginResponseDto);
      expect(result.user.id).toBe(user.id);
      expect(result.user.email).toBe(VALID_EMAIL);
      expect(updateLastLoginAt).toHaveBeenCalledWith(user.id, expect.any(Date));
    });

    it('auto-links and signs in an existing user with verified email', async () => {
      const user = buildUser({
        passwordHash,
        emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      findByProviderSubject.mockResolvedValue(null);
      findByEmail.mockResolvedValue(user);
      createIdentity.mockResolvedValue({
        id: 'ident-1',
        userId: user.id,
        provider: 'google',
        providerSubject: googlePayload.sub,
      });
      findById.mockResolvedValue(user);

      const result = await service.googleLogin({ idToken: 'valid-google-token' });

      expect(result).toBeInstanceOf(LoginResponseDto);
      expect(result.user.id).toBe(user.id);
    });

    it('rejects an existing user if email is unverified with 409 Conflict', async () => {
      const user = buildUser({
        passwordHash,
        emailVerifiedAt: null, // unverified
      });
      findByProviderSubject.mockResolvedValue(null);
      findByEmail.mockResolvedValue(user);

      await expect(
        service.googleLogin({ idToken: 'valid-google-token' }),
      ).rejects.toThrow(ConflictException);

      expect(createIdentity).not.toHaveBeenCalled();
    });

    it('rejects an inactive or suspended user via identity lookup', async () => {
      const user = buildUser({ passwordHash, status: 'SUSPENDED' });
      findByProviderSubject.mockResolvedValue({
        id: 'ident-1',
        userId: user.id,
        provider: 'google',
        providerSubject: googlePayload.sub,
        user,
      });

      await expect(
        service.googleLogin({ idToken: 'valid-google-token' }),
      ).rejects.toThrow(UnauthorizedException);
      expect(updateLastLoginAt).not.toHaveBeenCalled();
    });

    it('registers a new customer when no identity or user exists', async () => {
      const newUser = buildUser({
        id: 'new-user-id',
        passwordHash: 'unguessable-hash',
        role: Role.CUSTOMER,
        emailVerifiedAt: new Date(),
      });
      findByProviderSubject.mockResolvedValue(null);
      findByEmail.mockResolvedValue(null);
      createUser.mockResolvedValue(newUser);
      createIdentity.mockResolvedValue({
        id: 'ident-new',
        userId: newUser.id,
        provider: 'google',
        providerSubject: googlePayload.sub,
      });

      const result = await service.googleLogin({ idToken: 'valid-google-token' });

      expect(result).toBeInstanceOf(LoginResponseDto);
      expect(createUser).toHaveBeenCalledWith(
        expect.objectContaining({
          email: VALID_EMAIL,
          role: Role.CUSTOMER,
          firstName: 'Ada',
          lastName: 'Lovelace',
        }),
        expect.anything(),
      );
    });

    it('normalizes email casing and whitespace from Google payload to match existing user', async () => {
      const user = buildUser({
        passwordHash,
        email: VALID_EMAIL,
        emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      verifyGoogleToken.mockResolvedValue({
        ...googlePayload,
        email: '  ADA.LOVELACE@EXAMPLE.COM  ',
      });
      findByProviderSubject.mockResolvedValue(null);
      findByEmail.mockResolvedValue(user);
      findById.mockResolvedValue(user);

      const result = await service.googleLogin({ idToken: 'valid-google-token' });

      expect(result).toBeInstanceOf(LoginResponseDto);
      expect(findByEmail).toHaveBeenCalledWith(VALID_EMAIL);
    });

    it('preserves existing user role such as ADMIN when logging in via Google', async () => {
      const adminUser = buildUser({
        passwordHash,
        role: Role.ADMIN,
        emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      findByProviderSubject.mockResolvedValue(null);
      findByEmail.mockResolvedValue(adminUser);
      findById.mockResolvedValue(adminUser);

      const result = await service.googleLogin({ idToken: 'valid-google-token' });

      expect(result.user.role).toBe(Role.ADMIN);
    });

    it('rejects an inactive or suspended user matched by email', async () => {
      const suspendedUser = buildUser({
        passwordHash,
        status: 'SUSPENDED',
        emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      findByProviderSubject.mockResolvedValue(null);
      findByEmail.mockResolvedValue(suspendedUser);

      await expect(
        service.googleLogin({ idToken: 'valid-google-token' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('handles concurrent duplicate identity creation when auto-linking existing user by finding raced identity', async () => {
      const user = buildUser({
        passwordHash,
        emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      findByProviderSubject
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 'ident-raced',
          userId: user.id,
          provider: 'google',
          providerSubject: googlePayload.sub,
          user,
        });
      findByEmail.mockResolvedValue(user);
      prismaTransaction.mockRejectedValueOnce(makePrismaP2002Error());
      updateLastLoginAt.mockResolvedValue(user);

      const result = await service.googleLogin({ idToken: 'valid-google-token' });

      expect(result).toBeInstanceOf(LoginResponseDto);
      expect(result.user.id).toBe(user.id);
    });

    it('rejects identity transfer during concurrent race if raced identity belongs to another user', async () => {
      const user = buildUser({
        id: 'user-original',
        passwordHash,
        emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      findByProviderSubject
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 'ident-raced',
          userId: 'user-other',
          provider: 'google',
          providerSubject: googlePayload.sub,
          user: buildUser({ id: 'user-other' }),
        });
      findByEmail.mockResolvedValue(user);
      prismaTransaction.mockRejectedValueOnce(makePrismaP2002Error());

      await expect(
        service.googleLogin({ idToken: 'valid-google-token' }),
      ).rejects.toThrow(ConflictException);
    });

    it('rejects during concurrent auto-linking race if raced identity belongs to an inactive user', async () => {
      const user = buildUser({
        id: 'user-1',
        passwordHash,
        emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      findByProviderSubject
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 'ident-raced',
          userId: 'user-1',
          provider: 'google',
          providerSubject: googlePayload.sub,
          user: buildUser({ id: 'user-1', status: 'SUSPENDED' }),
        });
      findByEmail.mockResolvedValue(user);
      prismaTransaction.mockRejectedValueOnce(makePrismaP2002Error());

      await expect(
        service.googleLogin({ idToken: 'valid-google-token' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('handles concurrent race during customer registration when identity was created in parallel', async () => {
      const createdUser = buildUser({ id: 'user-created' });
      findByProviderSubject
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 'ident-raced',
          userId: createdUser.id,
          provider: 'google',
          providerSubject: googlePayload.sub,
          user: createdUser,
        });
      findByEmail.mockResolvedValue(null);
      prismaTransaction.mockRejectedValueOnce(makePrismaP2002Error());
      updateLastLoginAt.mockResolvedValue(createdUser);

      const result = await service.googleLogin({ idToken: 'valid-google-token' });

      expect(result).toBeInstanceOf(LoginResponseDto);
      expect(result.user.id).toBe(createdUser.id);
    });

    it('rejects during concurrent customer registration if raced user has unverified email', async () => {
      findByProviderSubject.mockResolvedValue(null);
      findByEmail
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(buildUser({ emailVerifiedAt: null }));
      prismaTransaction.mockRejectedValueOnce(makePrismaP2002Error());

      await expect(
        service.googleLogin({ idToken: 'valid-google-token' }),
      ).rejects.toThrow(ConflictException);
    });

    it('re-throws non-P2002 database errors during googleLogin', async () => {
      const user = buildUser({
        passwordHash,
        emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      findByProviderSubject.mockResolvedValue(null);
      findByEmail.mockResolvedValue(user);
      prismaTransaction.mockRejectedValueOnce(new Error('Connection failure'));

      await expect(
        service.googleLogin({ idToken: 'valid-google-token' }),
      ).rejects.toThrow('Connection failure');
    });
  });

  describe('linkGoogle', () => {
    const googlePayload = {
      sub: 'google-sub-999',
      email: VALID_EMAIL,
      emailVerified: true,
    };

    beforeEach(() => {
      verifyGoogleToken.mockResolvedValue(googlePayload);
    });

    it('successfully links Google identity to authenticated user', async () => {
      const user = buildUser({ passwordHash });
      findById.mockResolvedValue(user);
      findByProviderSubject.mockResolvedValue(null);
      createIdentity.mockResolvedValue({
        id: 'ident-999',
        userId: user.id,
        provider: 'google',
        providerSubject: googlePayload.sub,
      });

      const result = await service.linkGoogle(user.id, { idToken: 'valid-token' });

      expect(result).toEqual({ success: true, provider: 'google' });
    });

    it('rejects if identity is already linked to another user', async () => {
      const user = buildUser({ passwordHash, id: 'user-1' });
      findByProviderSubject.mockResolvedValue({
        id: 'ident-existing',
        userId: 'user-2', // different user
        provider: 'google',
        providerSubject: googlePayload.sub,
        user: buildUser({ id: 'user-2' }),
      });

      await expect(
        service.linkGoogle(user.id, { idToken: 'valid-token' }),
      ).rejects.toThrow(ConflictException);
      expect(createIdentity).not.toHaveBeenCalled();
    });

    it('returns success idempotently if identity is already linked to current user', async () => {
      const user = buildUser({ passwordHash, id: 'user-1' });
      findByProviderSubject.mockResolvedValue({
        id: 'ident-existing',
        userId: 'user-1', // same user
        provider: 'google',
        providerSubject: googlePayload.sub,
        user,
      });

      const result = await service.linkGoogle(user.id, { idToken: 'valid-token' });

      expect(result).toEqual({ success: true, provider: 'google' });
      expect(createIdentity).not.toHaveBeenCalled();
    });

    it('rejects when authenticated caller account is inactive or suspended', async () => {
      const user = buildUser({ passwordHash, id: 'user-inactive', status: 'SUSPENDED' });
      findById.mockResolvedValue(user);
      findByProviderSubject.mockResolvedValue(null);

      await expect(
        service.linkGoogle(user.id, { idToken: 'valid-token' }),
      ).rejects.toThrow(UnauthorizedException);
      expect(createIdentity).not.toHaveBeenCalled();
    });

    it('handles P2002 constraint error during linkGoogle by rejecting with ConflictException', async () => {
      const user = buildUser({ passwordHash, id: 'user-1' });
      findById.mockResolvedValue(user);
      findByProviderSubject.mockResolvedValue(null);
      prismaTransaction.mockRejectedValueOnce(makePrismaP2002Error());

      await expect(
        service.linkGoogle(user.id, { idToken: 'valid-token' }),
      ).rejects.toThrow(ConflictException);
    });

    it('re-throws non-P2002 errors during linkGoogle', async () => {
      const user = buildUser({ passwordHash, id: 'user-1' });
      findById.mockResolvedValue(user);
      findByProviderSubject.mockResolvedValue(null);
      prismaTransaction.mockRejectedValueOnce(new Error('Prisma unexpected error'));

      await expect(
        service.linkGoogle(user.id, { idToken: 'valid-token' }),
      ).rejects.toThrow('Prisma unexpected error');
    });

    it('marks unverified email as verified when Google verified email matches case-insensitively', async () => {
      const user = buildUser({
        passwordHash,
        id: 'user-unverified',
        email: 'user@example.com',
        emailVerifiedAt: null,
      });
      verifyGoogleToken.mockResolvedValue({
        sub: 'google-sub-999',
        email: 'USER@EXAMPLE.COM',
        emailVerified: true,
      });
      findById.mockResolvedValue(user);
      findByProviderSubject.mockResolvedValue(null);
      createIdentity.mockResolvedValue({
        id: 'ident-999',
        userId: user.id,
        provider: 'google',
        providerSubject: 'google-sub-999',
      });

      const result = await service.linkGoogle(user.id, { idToken: 'valid-token' });

      expect(result).toEqual({ success: true, provider: 'google' });
      expect(updateEmailVerifiedAt).toHaveBeenCalledWith(
        user.id,
        expect.any(Date),
        expect.anything(),
      );
    });
  });

  describe('getLinkedIdentities', () => {
    it('returns safe provider info without exposing subject identifiers', async () => {
      const date = new Date('2026-03-01T00:00:00.000Z');
      findIdentitiesByUserId.mockResolvedValue([
        {
          id: 'ident-1',
          provider: 'google',
          createdAt: date,
        },
      ]);

      const result = await service.getLinkedIdentities('user-1');

      expect(result).toEqual([
        {
          id: 'ident-1',
          provider: 'google',
          createdAt: date,
        },
      ]);
      expect(findIdentitiesByUserId).toHaveBeenCalledWith('user-1');
    });
  });
});
