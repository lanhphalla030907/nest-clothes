import { describe, expect, it } from 'vitest';
import {
  AdminOrderCodCollectionDto,
  type AdminOrderCodCollectionSource,
} from './admin-order-cod-collection.dto.js';

const COLLECTION: AdminOrderCodCollectionSource = {
  id: 'c3cec629-a304-42b9-bcce-6d1ae5292abb',
  amount: '6.50',
  currency: 'USD',
  collectedAt: new Date('2026-11-01T17:39:58.212Z'),
  collectedBy: {
    id: '3cf40e44-6a41-4d37-bb26-fca3b4afa758',
    firstName: 'Alex',
    lastName: 'Courier',
    email: 'alex@example.test',
  },
};

describe('AdminOrderCodCollectionDto', () => {
  it('maps a recorded collection with its amount, currency, timestamp and collector', () => {
    const dto = AdminOrderCodCollectionDto.fromOrder('COD', [COLLECTION]);

    expect(dto).toMatchObject({
      status: 'COLLECTED',
      amount: '6.50',
      currency: 'USD',
      collectedAt: new Date('2026-11-01T17:39:58.212Z'),
      collector: {
        id: '3cf40e44-6a41-4d37-bb26-fca3b4afa758',
        firstName: 'Alex',
        lastName: 'Courier',
        email: 'alex@example.test',
      },
    });
  });

  it('reports NOT_COLLECTED for a COD order with no collection row', () => {
    expect(AdminOrderCodCollectionDto.fromOrder('COD', [])).toEqual({
      status: 'NOT_COLLECTED',
      amount: null,
      currency: null,
      collectedAt: null,
      collector: null,
    });
  });

  it('returns null for a non-COD order with no collection row', () => {
    expect(
      AdminOrderCodCollectionDto.fromOrder('ABA_PAYWAY', undefined),
    ).toBeNull();
  });

  it('still reports a recorded collection when the payment method is not COD', () => {
    expect(
      AdminOrderCodCollectionDto.fromOrder('ABA_PAYWAY', [COLLECTION]),
    ).toMatchObject({ status: 'COLLECTED', amount: '6.50' });
  });

  it('exposes only safe collector fields', () => {
    const dto = AdminOrderCodCollectionDto.fromEntity(COLLECTION);

    expect(Object.keys(dto.collector ?? {})).toEqual([
      'id',
      'firstName',
      'lastName',
      'email',
    ]);
    expect(JSON.stringify(dto)).not.toContain('passwordHash');
    expect(JSON.stringify(dto)).not.toContain('receiptProof');
  });
});
