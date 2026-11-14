import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { StockAlertsQueryDto } from './stock-alerts-query.dto.js';

const validateDto = async (partial: Record<string, unknown>) => {
  const dto = plainToInstance(StockAlertsQueryDto, partial);
  return validate(dto);
};

describe('StockAlertsQueryDto validation', () => {
  it.each(['alerts', 'all', 'in', 'low', 'out'])(
    'accepts status=%s',
    async (status) => {
      const errors = await validateDto({ page: 1, limit: 10, status });
      expect(errors).toHaveLength(0);
    },
  );

  it('defaults page and limit when absent', async () => {
    const dto = plainToInstance(StockAlertsQueryDto, { status: 'in' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.page).toBe(1);
    expect(dto.limit).toBe(10);
  });

  it('rejects unsupported status values', async () => {
    const errors = await validateDto({
      page: 1,
      limit: 10,
      status: 'in-stock',
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'status')).toBe(true);
  });

  it('rejects non-integer limits', async () => {
    const errors = await validateDto({ page: 1, limit: 3, status: 'all' });
    expect(errors.some((e) => e.property === 'limit')).toBe(true);
  });

  it('rejects unsupported limits', async () => {
    const errors = await validateDto({ page: 1, limit: 3, status: 'all' });
    const limitError = errors.find((e) => e.property === 'limit');
    expect(limitError?.constraints).toBeDefined();
  });
});
