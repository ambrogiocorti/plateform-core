import { describe, expect, it } from 'vitest';
import { evaluateSetup, setupDefinitions } from '../../src/services/setup-readiness';
import type { SetupFacts } from '../../src/services/setup-readiness';

const empty = Object.fromEntries(setupDefinitions.map((step) => [step.key, false])) as unknown as SetupFacts;

describe('minimum restaurant configuration guide', () => {
  it('never describes an empty installation as configured', () => {
    const status = evaluateSetup(empty);
    expect(status.basicsConfigured).toBe(false);
    expect(status.completed).toBe(0);
    expect(status.total).toBe(8);
    expect(status.next?.key).toBe('rooms');
  });

  it('points the Admin to the first incomplete dependency rather than skipping it', () => {
    const status = evaluateSetup({
      ...empty,
      rooms: true,
      room_layouts: true,
      tables: false,
      services: true,
      stations: true,
      categories: true,
      dishes: true,
      cash_registers: true,
    });
    expect(status.completed).toBe(7);
    expect(status.next?.key).toBe('tables');
    expect(status.basicsConfigured).toBe(false);
  });

  it('completes only when all eight real prerequisites have been checked', () => {
    const all = Object.fromEntries(setupDefinitions.map((step) => [step.key, true])) as unknown as SetupFacts;
    const status = evaluateSetup(all);
    expect(status.basicsConfigured).toBe(true);
    expect(status.next).toBeNull();
    expect(status.completed).toBe(status.total);
  });

  it('never certifies catalog readiness or exposes editable routes to venue-only admins', () => {
    const result = evaluateSetup({
      ...empty,
      rooms: true,
      room_layouts: true,
      tables: true,
      services: true,
      stations: true,
      categories: 'MANAGED_BY_CHAIN',
      dishes: 'MANAGED_BY_CHAIN',
      cash_registers: true,
    });
    expect(result.completed).toBe(6);
    expect(result.basicsConfigured).toBe(false);
    expect(result.next?.key).toBe('categories');
    expect(result.next?.requiresChain).toBe(true);
  });

  it('keeps navigation within the available admin configuration screens', () => {
    expect(new Set(setupDefinitions.map((step) => step.key)).size).toBe(8);
    for (const step of setupDefinitions) {
      expect(step.route).toBe(`/gestione?modulo=${step.key}`);
      expect(step.title.trim().length).toBeGreaterThan(0);
    }
  });
});
