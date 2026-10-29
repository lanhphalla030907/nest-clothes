import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateShippingProviderDto } from './create-shipping-provider.dto.js';
import { UpdateShippingProviderDto } from './update-shipping-provider.dto.js';

describe('Shipping provider DTO validation', () => {
  it('normalizes valid codes and amounts before validation', async () => {
    const dto = plainToInstance(CreateShippingProviderDto, {
      code: ' virak-buntham ',
      name: ' Virak Buntham ',
      baseFee: '0',
      supportsCod: true,
    });

    expect(dto.code).toBe('VIRAK-BUNTHAM');
    expect(dto.name).toBe('Virak Buntham');
    expect(dto.baseFee).toBe('0.00');
    expect(await validate(dto)).toHaveLength(0);
  });

  it.each([
    { code: '  ', name: 'Provider', baseFee: '1.00' },
    { code: 'BAD CODE', name: 'Provider', baseFee: '1.00' },
    { code: 'VALID', name: 'Provider', baseFee: '-1.00' },
    { code: 'VALID', name: '   ', baseFee: '1.00' },
    { code: 'VALID', name: 'Provider', baseFee: '1.001' },
  ])('rejects invalid provider input %#', async (value) => {
    const dto = plainToInstance(CreateShippingProviderDto, value);
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it('accepts a partial update without requiring omitted fields', async () => {
    const dto = plainToInstance(UpdateShippingProviderDto, {
      baseFee: '12.5',
      isActive: false,
    });

    expect(dto.baseFee).toBe('12.50');
    expect(await validate(dto)).toHaveLength(0);
  });
});
