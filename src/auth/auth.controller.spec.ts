import { UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { UserResponseDto } from '../users/dto/user-response.dto.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { LoginDto } from './dto/login.dto.js';

const VALID_PASSWORD = 'Str0ng!Passw0rd';

const buildLoginDto = (): LoginDto =>
  Object.assign(new LoginDto(), {
    email: 'ada.lovelace@example.com',
    password: VALID_PASSWORD,
  });

const buildResponse = (): UserResponseDto =>
  Object.assign(new UserResponseDto(), {
    id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada.lovelace@example.com',
    phone: null,
    status: 'ACTIVE',
    emailVerifiedAt: null,
    lastLoginAt: new Date('2026-02-02T10:00:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  });

describe('AuthController', () => {
  let controller: AuthController;
  let authService: { login: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    authService = { login: vi.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: authService }],
    }).compile();

    controller = module.get<AuthController>(AuthController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('delegates authentication to AuthService and returns its result', async () => {
    const dto = buildLoginDto();
    const expected = buildResponse();
    authService.login.mockResolvedValue(expected);

    await expect(controller.login(dto)).resolves.toBe(expected);
    expect(authService.login).toHaveBeenCalledTimes(1);
    expect(authService.login).toHaveBeenCalledWith(dto);
  });

  it('never returns passwordHash or the supplied password', async () => {
    authService.login.mockResolvedValue(buildResponse());

    const result = await controller.login(buildLoginDto());

    expect(Object.keys(result)).not.toContain('passwordHash');
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('passwordHash');
    expect(serialised).not.toContain(VALID_PASSWORD);
  });

  it('propagates authentication failures to the exception layer', async () => {
    authService.login.mockRejectedValue(
      new UnauthorizedException('Invalid email or password'),
    );

    await expect(controller.login(buildLoginDto())).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
