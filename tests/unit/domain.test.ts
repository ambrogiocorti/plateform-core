import { describe, expect, it } from 'vitest';
import { availabilityBadge } from '../../src/services/menu';
import {
  formatMoney,
  parseMoney,
  percentageDiscount,
  splitEqually,
} from '../../src/services/money';
import { canTransition, stateMachines } from '../../src/services/state-machine';
import { menuDishSchema } from '../../src/types/domain';

describe('Financial presentation uses exact integer arithmetic', () => {
  it('parses Italian decimals exactly and rejects ambiguous precision', () => {
    expect(parseMoney('18,09')).toBe(1809n);
    expect(parseMoney('0.01')).toBe(1n);
    expect(() => parseMoney('1.999')).toThrow();
    expect(() => parseMoney('1e3')).toThrow();
    expect(() => parseMoney('-10')).toThrow();
  });
  it('preserves every cent in equal splits', () => {
    for (let parts = 1; parts < 30; parts++) {
      const shares = splitEqually(10001n, parts);
      expect(shares.reduce((a, b) => a + b, 0n)).toBe(10001n);
      expect(shares[0]! - shares[shares.length - 1]!).toBeLessThanOrEqual(1n);
    }
  });
  it('rounds a percentage once', () => {
    expect(percentageDiscount(1001n, 1000)).toBe(100n);
    expect(percentageDiscount(999n, 10000)).toBe(999n);
  });
  it('formats large integer cents and negative sub-unit values without losing a cent', () => {
    expect(formatMoney(9007199254740991n, 'EUR', 'en-US')).toBe('€90,071,992,547,409.91');
    expect(formatMoney(-1n, 'EUR', 'en-US')).toBe('-€0.01');
    expect(formatMoney(1809n, 'EUR', 'it-IT')).toContain('18,09');
  });
});
describe('Operational boundaries', () => {
  it.each([
    [null, 'none'],
    [11, 'none'],
    [10, 'warning'],
    [6, 'warning'],
    [5, 'urgent'],
    [2, 'urgent'],
    [1, 'urgent'],
    [0, 'sold-out'],
  ] as const)('labels stock %s as %s', (count, severity) => {
    expect(availabilityBadge(count).severity).toBe(severity);
  });
  it('does not permit skipping payment or reservation steps', () => {
    expect(canTransition(stateMachines.account, 'OPEN', 'CLOSED')).toBe(false);
    expect(canTransition(stateMachines.reservation, 'REQUESTED', 'SEATED')).toBe(false);
    expect(canTransition(stateMachines.payment, 'FAILED', 'COMPLETED')).toBe(false);
    expect(canTransition(stateMachines.order, 'IN_PREPARATION', 'READY')).toBe(true);
  });
});

describe('Menu payloads', () => {
  it('accepts a dish saved without description, so the whole menu still renders', () => {
    const dish = menuDishSchema.parse({
      id: '40000000-0000-4000-8000-0000000000e8',
      name: 'Carbonara',
      description: null,
      image_path: null,
      beverage: false,
      category_id: '40000000-0000-4000-8000-0000000000e7',
      category_name: 'Primi',
      price_cents: 1400,
      availability: null,
      ingredients: [],
      allergens: [],
      dietary_tags: [],
      variant_groups: [],
    });
    expect(dish.description).toBe('');
  });
});
