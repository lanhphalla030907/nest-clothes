import { describe, expect, it } from 'vitest';
import {
  availableStock,
  stockStatusFor,
} from './available-stock.js';

describe('availableStock', () => {
  it('derives the sellable amount from the two counters', () => {
    expect(availableStock({ quantity: 100, reservedQuantity: 0 })).toBe(100);
    expect(availableStock({ quantity: 12, reservedQuantity: 5 })).toBe(7);
    expect(availableStock({ quantity: 0, reservedQuantity: 0 })).toBe(0);
  });
});

describe('stockStatusFor', () => {
  it('treats anything above the threshold as in stock', () => {
    expect(stockStatusFor(11)).toBe('IN_STOCK');
    expect(stockStatusFor(100)).toBe('IN_STOCK');
  });

  it('treats 1 through 10 as low stock', () => {
    expect(stockStatusFor(10)).toBe('LOW_STOCK');
    expect(stockStatusFor(1)).toBe('LOW_STOCK');
  });

  it('treats 0 and below as out of stock', () => {
    expect(stockStatusFor(0)).toBe('OUT_OF_STOCK');
    expect(stockStatusFor(-1)).toBe('OUT_OF_STOCK');
  });
});