import { describe, expect, it } from 'vitest';
import { kitchenAllergensSchema, kitchenTicketHeading } from '../../src/pages/kitchen';

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

describe('kitchen board identifiers', () => {
  it('keeps the table label for seated restaurant orders', () => {
    expect(
      kitchenTicketHeading({
        table_name: 'Tavolo 1',
        table_number: 1,
        service_label: 'Tavolo 1',
        order_source: 'TABLE',
      }),
    ).toEqual({ eyebrow: 'TAVOLO 1', title: 'Tavolo 1' });
  });

  it('shows the pickup context for takeaway orders without a table', () => {
    expect(
      kitchenTicketHeading({
        table_name: null,
        table_number: null,
        service_label: 'TAKEAWAY — ritiro 20:30',
        order_source: 'TAKEAWAY',
      }),
    ).toEqual({ eyebrow: 'ASPORTO', title: 'TAKEAWAY — ritiro 20:30' });
  });
});
