import {
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '../generated/prisma/client.js';
import { CreateCodAreaDto } from './dto/create-cod-area.dto.js';
import { UpdateCodAreaDto } from './dto/update-cod-area.dto.js';
import { CodAreasRepository } from './repositories/cod-areas.repository.js';
import { CodAreasService } from './cod-areas.service.js';

const area = (overrides: Record<string, unknown> = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  code: 'PHNOM-PENH',
  name: 'Phnom Penh',
  codEnabled: false,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  updatedAt: new Date('2026-10-01T00:00:00.000Z'),
  ...overrides,
});

const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '7.10.0',
    meta: {
      modelName: 'CodArea',
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          originalCode: '23505',
          kind: 'UniqueConstraintViolation',
          constraint: { index: 'cod_areas_code_key' },
          table: 'cod_areas',
        },
      },
    },
  });

describe('CodAreasService', () => {
  let service: CodAreasService;
  let repository: {
    create: ReturnType<typeof vi.fn>;
    findAll: ReturnType<typeof vi.fn>;
    findCodEnabled: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    findByCode: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    repository = {
      create: vi.fn(),
      findAll: vi.fn(),
      findCodEnabled: vi.fn(),
      findById: vi.fn(),
      findByCode: vi.fn(),
      update: vi.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CodAreasService,
        { provide: CodAreasRepository, useValue: repository },
      ],
    }).compile();
    service = module.get(CodAreasService);
  });

  it('creates a normalized area disabled by default', async () => {
    repository.findByCode.mockResolvedValue(null);
    repository.create.mockImplementation((data: Record<string, unknown>) =>
      Promise.resolve(area(data)),
    );

    const result = await service.create(
      Object.assign(new CreateCodAreaDto(), {
        code: ' phnom-penh ',
        name: ' Phnom Penh ',
      }),
    );

    expect(repository.create).toHaveBeenCalledWith({
      code: 'PHNOM-PENH',
      name: 'Phnom Penh',
      codEnabled: false,
    });
    expect(result.codEnabled).toBe(false);
  });

  it('rejects duplicate codes before writing and handles a uniqueness race', async () => {
    repository.findByCode.mockResolvedValue(area());
    await expect(
      service.create(
        Object.assign(new CreateCodAreaDto(), {
          code: 'phnom-penh',
          name: 'Phnom Penh',
        }),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(repository.create).not.toHaveBeenCalled();

    repository.findByCode.mockResolvedValue(null);
    repository.create.mockRejectedValue(uniqueViolation());
    await expect(
      service.create(
        Object.assign(new CreateCodAreaDto(), {
          code: 'PHNOM-PENH',
          name: 'Phnom Penh',
        }),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('updates the display name and COD eligibility', async () => {
    repository.findById.mockResolvedValue(area());
    repository.update.mockImplementation(
      (_id: string, data: Record<string, unknown>) =>
        Promise.resolve(area({ ...data })),
    );

    const result = await service.update(
      area().id,
      Object.assign(new UpdateCodAreaDto(), {
        name: 'Phnom Penh Municipality',
        codEnabled: true,
      }),
    );

    expect(repository.update).toHaveBeenCalledWith(area().id, {
      name: 'Phnom Penh Municipality',
      codEnabled: true,
    });
    expect(result.codEnabled).toBe(true);
  });

  it('returns 404 for an unknown area identifier', async () => {
    repository.findById.mockResolvedValue(null);

    await expect(
      service.update(
        'missing',
        Object.assign(new UpdateCodAreaDto(), { codEnabled: true }),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('returns only explicitly enabled areas in the public projection', async () => {
    repository.findCodEnabled.mockResolvedValue([
      area({ codEnabled: true }),
    ]);

    expect(await service.listCodEnabled()).toEqual([
      {
        id: '11111111-1111-4111-8111-111111111111',
        code: 'PHNOM-PENH',
        name: 'Phnom Penh',
      },
    ]);
    expect(repository.findCodEnabled).toHaveBeenCalledOnce();
  });

  it('returns enabled and disabled entries for administration', async () => {
    repository.findAll.mockResolvedValue([
      area({ codEnabled: true }),
      area({ id: 'another', code: 'OTHER', name: 'Other', codEnabled: false }),
    ]);

    expect(await service.listForAdmin()).toEqual([
      expect.objectContaining({
        id: '11111111-1111-4111-8111-111111111111',
        code: 'PHNOM-PENH',
        name: 'Phnom Penh',
        codEnabled: true,
      }),
      expect.objectContaining({
        id: 'another',
        code: 'OTHER',
        name: 'Other',
        codEnabled: false,
      }),
    ]);
  });
});
