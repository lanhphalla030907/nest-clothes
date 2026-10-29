import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '../generated/prisma/client.js';
import { CreateShippingProviderDto } from './dto/create-shipping-provider.dto.js';
import { ShippingProviderResponseDto } from './dto/shipping-provider-response.dto.js';
import { UpdateShippingProviderDto } from './dto/update-shipping-provider.dto.js';
import { ShippingProvidersRepository } from './repositories/shipping-providers.repository.js';
import { ShippingProvidersService } from './shipping-providers.service.js';

const provider = (overrides: Record<string, unknown> = {}) => ({
  id: 'provider-1',
  code: 'LOCAL-DELIVERY',
  name: 'Store delivery',
  description: null,
  baseFee: new Prisma.Decimal('2.50'),
  isActive: true,
  supportsCod: false,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  updatedAt: new Date('2026-10-01T00:00:00.000Z'),
  ...overrides,
});

const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '7.10.0',
    meta: {
      modelName: 'ShippingProvider',
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: {
          originalCode: '23505',
          kind: 'UniqueConstraintViolation',
          constraint: { index: 'shipping_providers_code_key' },
          table: 'shipping_providers',
        },
      },
    },
  });

describe('ShippingProvidersService', () => {
  let service: ShippingProvidersService;
  let repository: {
    create: ReturnType<typeof vi.fn>;
    findAll: ReturnType<typeof vi.fn>;
    findActive: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    findByCode: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    repository = {
      create: vi.fn(),
      findAll: vi.fn(),
      findActive: vi.fn(),
      findById: vi.fn(),
      findByCode: vi.fn(),
      update: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ShippingProvidersService,
        { provide: ShippingProvidersRepository, useValue: repository },
      ],
    }).compile();

    service = module.get(ShippingProvidersService);
  });

  it('creates a normalized provider with safe defaults and a fixed money string', async () => {
    repository.findByCode.mockResolvedValue(null);
    repository.create.mockImplementation((data: Record<string, unknown>) =>
      Promise.resolve(provider(data)),
    );

    const result = await service.create(
      Object.assign(new CreateShippingProviderDto(), {
        code: '  jt-express ',
        name: ' J&T Express ',
        baseFee: '3.5',
      }),
    );

    expect(repository.create).toHaveBeenCalledWith({
      code: 'JT-EXPRESS',
      name: 'J&T Express',
      description: null,
      baseFee: '3.50',
      isActive: true,
      supportsCod: false,
    });
    expect(result).toBeInstanceOf(ShippingProviderResponseDto);
    expect(result.baseFee).toBe('3.50');
  });

  it('rejects a negative fee without writing', async () => {
    repository.findByCode.mockResolvedValue(null);

    await expect(
      service.create(
        Object.assign(new CreateShippingProviderDto(), {
          code: 'COURIER',
          name: 'Courier',
          baseFee: '-1.00',
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('rejects a duplicate normalized code before writing', async () => {
    repository.findByCode.mockResolvedValue(provider());

    await expect(
      service.create(
        Object.assign(new CreateShippingProviderDto(), {
          code: ' local-delivery ',
          name: 'Another delivery',
          baseFee: '0',
        }),
      ),
    ).rejects.toThrow('A shipping provider with this code already exists');
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('maps a database uniqueness race to a conflict', async () => {
    repository.findByCode.mockResolvedValue(null);
    repository.create.mockRejectedValue(uniqueViolation());

    await expect(
      service.create(
        Object.assign(new CreateShippingProviderDto(), {
          code: 'LOCAL-DELIVERY',
          name: 'Store delivery',
          baseFee: '2.50',
        }),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('lists every provider for management, including inactive providers', async () => {
    repository.findAll.mockResolvedValue([
      provider(),
      provider({ id: 'inactive', isActive: false }),
    ]);

    const result = await service.listForAdmin();

    expect(result).toHaveLength(2);
    expect(result[1].isActive).toBe(false);
  });

  it('updates provider fields and supports activation changes', async () => {
    repository.findById.mockResolvedValue(provider({ isActive: false }));
    repository.update.mockImplementation(
      (_id: string, data: Record<string, unknown>) =>
        Promise.resolve(provider({ ...data })),
    );

    const result = await service.update(
      'provider-1',
      Object.assign(new UpdateShippingProviderDto(), {
        baseFee: '4',
        supportsCod: true,
        isActive: true,
      }),
    );

    expect(repository.update).toHaveBeenCalledWith('provider-1', {
      baseFee: '4.00',
      supportsCod: true,
      isActive: true,
    });
    expect(result.isActive).toBe(true);
    expect(result.supportsCod).toBe(true);
  });

  it('maps a duplicate code on update to a conflict', async () => {
    repository.findById.mockResolvedValue(provider());
    repository.findByCode.mockResolvedValue(provider({ id: 'another' }));

    await expect(
      service.update(
        'provider-1',
        Object.assign(new UpdateShippingProviderDto(), { code: 'other-code' }),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown provider on update', async () => {
    repository.findById.mockResolvedValue(null);

    await expect(
      service.update('missing', Object.assign(new UpdateShippingProviderDto(), { name: 'Courier' })),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
