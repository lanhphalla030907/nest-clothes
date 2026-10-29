import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateCodAreaDto } from './create-cod-area.dto.js';
import { UpdateCodAreaDto } from './update-cod-area.dto.js';

describe('COD area DTOs', () => {
  it('normalizes canonical codes and trims names', async () => {
    const dto = plainToInstance(CreateCodAreaDto, {
      code: ' phnom-penh ',
      name: ' Phnom Penh ',
    });

    expect(await validate(dto)).toHaveLength(0);
    expect(dto.code).toBe('PHNOM-PENH');
    expect(dto.name).toBe('Phnom Penh');
  });

  it.each(['', 'PHNOM--PENH', '-PHNOM', 'PHNOM_1'])(
    'rejects invalid area code %j',
    async (code) => {
      const dto = plainToInstance(CreateCodAreaDto, {
        code,
        name: 'Phnom Penh',
      });

      expect(await validate(dto)).not.toHaveLength(0);
    },
  );

  it('rejects blank names and null COD state updates', async () => {
    const create = plainToInstance(CreateCodAreaDto, {
      code: 'PHNOM-PENH',
      name: '   ',
    });
    const update = plainToInstance(UpdateCodAreaDto, { codEnabled: null });

    expect(await validate(create)).not.toHaveLength(0);
    expect(await validate(update)).not.toHaveLength(0);
  });
});
