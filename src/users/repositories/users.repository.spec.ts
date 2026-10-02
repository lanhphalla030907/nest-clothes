import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service.js';
import { UsersRepository } from './users.repository.js';

describe('UsersRepository', () => {
  let repository: UsersRepository;
  let findUnique: ReturnType<typeof vi.fn>;
  let create: ReturnType<typeof vi.fn>;
  let update: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    findUnique = vi.fn();
    create = vi.fn();
    update = vi.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersRepository,
        {
          provide: PrismaService,
          useValue: { user: { findUnique, create, update } },
        },
      ],
    }).compile();

    repository = module.get<UsersRepository>(UsersRepository);
  });

  it('should be defined', () => {
    expect(repository).toBeDefined();
  });

  it('findByEmail queries the unique email and returns the entity', async () => {
    const user = { id: 'user-1', email: 'ada@example.com' };
    findUnique.mockResolvedValue(user);

    await expect(repository.findByEmail('ada@example.com')).resolves.toBe(user);
    expect(findUnique).toHaveBeenCalledWith({
      where: { email: 'ada@example.com' },
    });
  });

  it('findByEmail returns null when no user matches', async () => {
    findUnique.mockResolvedValue(null);

    await expect(repository.findByEmail('nobody@example.com')).resolves.toBeNull();
  });

  it('create forwards the supplied data unchanged', async () => {
    const data = {
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      passwordHash: '$argon2id$digest',
      status: 'ACTIVE',
    };
    const user = { id: 'user-1', ...data };
    create.mockResolvedValue(user);

    await expect(repository.create(data)).resolves.toBe(user);
    expect(create).toHaveBeenCalledWith({ data });
  });

  it('updateLastLoginAt writes only lastLoginAt', async () => {
    const lastLoginAt = new Date('2026-02-02T10:00:00.000Z');
    const user = { id: 'user-1', lastLoginAt };
    update.mockResolvedValue(user);

    await expect(
      repository.updateLastLoginAt('user-1', lastLoginAt),
    ).resolves.toBe(user);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { lastLoginAt },
    });
  });
});
