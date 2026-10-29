import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CodAreasRepository } from './cod-areas.repository.js';

describe('CodAreasRepository', () => {
  let repository: CodAreasRepository;
  const prisma = {
    codArea: {
      findMany: vi.fn(),
    },
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CodAreasRepository,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    repository = module.get(CodAreasRepository);
  });

  it('filters public results to COD-enabled areas and orders them by name', async () => {
    prisma.codArea.findMany.mockResolvedValue([]);

    await repository.findCodEnabled();

    expect(prisma.codArea.findMany).toHaveBeenCalledWith({
      where: { codEnabled: true },
      orderBy: [{ name: 'asc' }, { code: 'asc' }],
    });
  });
});
