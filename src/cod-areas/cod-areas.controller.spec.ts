import { Test, TestingModule } from '@nestjs/testing';
import { CodAreasService } from './cod-areas.service.js';
import { CodAreasController } from './cod-areas.controller.js';

describe('CodAreasController', () => {
  let controller: CodAreasController;
  const service = { listCodEnabled: vi.fn() };

  beforeEach(async () => {
    vi.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CodAreasController],
      providers: [{ provide: CodAreasService, useValue: service }],
    }).compile();
    controller = module.get(CodAreasController);
  });

  it('returns only the public fields for COD-enabled areas', async () => {
    service.listCodEnabled.mockResolvedValue([
      {
        id: '11111111-1111-4111-8111-111111111111',
        code: 'PHNOM-PENH',
        name: 'Phnom Penh',
      },
    ]);

    expect(await controller.findCodEnabled()).toEqual([
      {
        id: '11111111-1111-4111-8111-111111111111',
        code: 'PHNOM-PENH',
        name: 'Phnom Penh',
      },
    ]);
    expect(service.listCodEnabled).toHaveBeenCalledOnce();
  });
});
