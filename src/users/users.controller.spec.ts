import { Test, TestingModule } from '@nestjs/testing';
import { CreateUserDto } from './dto/create-user.dto.js';
import { UserResponseDto } from './dto/user-response.dto.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

describe('UsersController', () => {
  let controller: UsersController;
  let usersService: { create: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    usersService = { create: vi.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [{ provide: UsersService, useValue: usersService }],
    }).compile();

    controller = module.get<UsersController>(UsersController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('delegates creation to the service and returns its result', () => {
    const dto = Object.assign(new CreateUserDto(), {
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada.lovelace@example.com',
      password: 'Str0ng!Passw0rd',
    });
    const expected = Object.assign(new UserResponseDto(), {
      id: 'user-1',
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada.lovelace@example.com',
      phone: null,
      status: 'ACTIVE',
      emailVerifiedAt: null,
      lastLoginAt: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    usersService.create.mockReturnValue(expected);

    expect(controller.create(dto)).toBe(expected);
    expect(usersService.create).toHaveBeenCalledTimes(1);
    expect(usersService.create).toHaveBeenCalledWith(dto);
  });

  it('does not expose passwordHash in the controller response', () => {
    usersService.create.mockReturnValue(
      Object.assign(new UserResponseDto(), {
        id: 'user-1',
        email: 'ada.lovelace@example.com',
      }),
    );

    const result = controller.create(
      Object.assign(new CreateUserDto(), {
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada.lovelace@example.com',
        password: 'Str0ng!Passw0rd',
      }),
    );

    expect(Object.keys(result)).not.toContain('passwordHash');
    expect(JSON.stringify(result)).not.toContain('Str0ng!Passw0rd');
  });
});