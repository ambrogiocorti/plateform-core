import { describe, expect, it } from 'vitest';
import {
  engineeringClassificationLabel,
  menuEngineeringCostAt,
  validMenuEngineeringPeriod,
} from '../../src/services/menu-engineering';

describe('menu engineering date boundaries', () => {
  it('uses the report end date in the venue timezone for historical cost details', () => {
    for (const date of ['2026-03-29', '2026-10-25']) {
      expect(menuEngineeringCostAt(date, 'Europe/Rome')).toBe(
        `${date} 23:59:59.999999 Europe/Rome`,
      );
    }
    expect(() => menuEngineeringCostAt('2026-02-30', 'Europe/Rome')).toThrow();
    expect(() => menuEngineeringCostAt('2026-10-16', 'Invalid/Timezone')).toThrow();
  });
  it('accepts finite same-day and <=366-day reports', () => {
    expect(validMenuEngineeringPeriod('2026-10-13', '2026-10-13')).toBe(true);
    expect(validMenuEngineeringPeriod('2025-10-13', '2026-10-14')).toBe(true);
  });

  it('rejects invalid dates, reversals and excessive periods before calling SQL', () => {
    for (const [start, end] of [
      ['2026-02-30', '2026-03-01'],
      ['2026-10-14', '2026-10-13'],
      ['2025-01-01', '2026-10-13'],
      ['2026-10-13', '2026-99-99'],
      ['tomorrow', '2026-10-13'],
    ]) {
      expect(validMenuEngineeringPeriod(start, end)).toBe(false);
    }
  });

  it('keeps uncertain or future classification transparent', () => {
    expect(engineeringClassificationLabel('INCOMPLETE_COST')).toContain('incompleto');
    expect(engineeringClassificationLabel('CUSTOM_CLASS')).toBe('CUSTOM CLASS');
  });
});
