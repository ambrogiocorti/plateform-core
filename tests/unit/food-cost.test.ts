import { describe, expect, it } from 'vitest';
import { parsePurchaseCostMicros } from '../../src/services/food-cost';

describe('EUR ingredient purchase cost, integer micro precision', () => {
  it.each([
    ['1', 1000000],
    ['1,25', 1250000],
    ['0.000001', 1],
    ['4,250000', 4250000],
    ['999999.999999', 999999999999],
  ])('parses %s exactly', (source, micros) => {
    expect(parsePurchaseCostMicros(source)).toBe(micros);
  });
  it.each(['', '0', '0,000000', '-1', '1.0000001', 'NaN', '1e3', '1.2.3', '1000000'])(
    'rejects invalid amount %s',
    (source) => {
      expect(() => parsePurchaseCostMicros(source)).toThrow();
    },
  );
});
