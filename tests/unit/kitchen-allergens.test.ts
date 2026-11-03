import { describe, expect, it } from 'vitest';
import { kitchenAllergensSchema } from '../../src/pages/kitchen';

describe('kitchen allergen snapshots', () => {
  it('renders the PostgreSQL snapshots as names in deterministic allergen-code order', () => {
    expect(
      kitchenAllergensSchema.parse([
        { code: 'MILK', name: 'Latte' },
        { code: 'EGGS', name: 'Uova' },
      ]),
    ).toEqual(['Uova', 'Latte']);
  });

  it('continues to accept historical string snapshots without changing their order', () => {
    expect(kitchenAllergensSchema.parse(['Uova', 'Latte'])).toEqual(['Uova', 'Latte']);
  });

  it('rejects records that cannot identify an allergen by name', () => {
    expect(() => kitchenAllergensSchema.parse([{ code: 'MILK' }])).toThrow();
  });
});
