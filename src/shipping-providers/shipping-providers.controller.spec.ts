import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '../generated/prisma/client.js';
import { ShippingProvidersService } from './shipping-providers.service.js';
import { ShippingProvidersController } from './shipping-providers.controller.js';

describe('ShippingProvidersController', () => {
  let controller: ShippingProvidersController;
  const service = { listActive: vi.fn() };

  beforeEach(async () => {
    vi.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ShippingProvidersController],
      providers: [{ provide: ShippingProvidersService, useValue: service }],
    }).compile();
    controller = module.get(ShippingProvidersController);
  });

  it('returns only active providers and omits administrative state', async () => {
    service.listActive.mockResolvedValue([
      {
        id: 'provider-1',
        code: 'LOCAL',
        name: 'Store delivery',
        description: null,
        baseFee: new Prisma.Decimal('0.00'),
        isActive: true,
        supportsCod: true,
        createdAt: new Date('2026-10-01T00:00:00.000Z'),
        updatedAt: new Date('2026-10-01T00:00:00.000Z'),
      },
    ]);

    const result = await controller.findActive();

    expect(service.listActive).toHaveBeenCalledOnce();
    expect(result).toEqual([
      {
        id: 'provider-1',
        code: 'LOCAL',
        name: 'Store delivery',
        description: null,
        baseFee: '0.00',
        supportsCod: true,
      },
    ]);
  });
});
