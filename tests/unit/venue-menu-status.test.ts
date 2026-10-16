import { describe, expect, it } from 'vitest';
import { venueDishSetupState } from '../../src/services/venue-menu-status';

const active = new Set(['station-a']);
const today = '2026-10-12';

describe('local dish overrides never silently publish an unavailable item', () => {
  it('allows inherited catalog settings with a valid primary kitchen station', () => {
    expect(venueDishSetupState(undefined, 'station-a', active, today)).toBe('CONFIGURED');
  });

  it('marks disabled and sold-out overrides as unavailable', () => {
    expect(
      venueDishSetupState(
        { enabled: false, availability: null, availability_date: null, local_station_id: null },
        'station-a',
        active,
        today,
      ),
    ).toBe('DISABLED');
    expect(
      venueDishSetupState(
        { enabled: true, availability: 0, availability_date: today, local_station_id: null },
        'station-a',
        active,
        today,
      ),
    ).toBe('SOLD_OUT');
    expect(
      venueDishSetupState(
        { enabled: true, availability: 8, availability_date: '2026-10-11', local_station_id: null },
        'station-a',
        active,
        today,
      ),
    ).toBe('SOLD_OUT');
  });

  it('does not fall back to the shared station when local station override is invalid', () => {
    expect(
      venueDishSetupState(
        { enabled: true, availability: null, availability_date: null, local_station_id: 'other' },
        'station-a',
        active,
        today,
      ),
    ).toBe('NEEDS_STATION');
    expect(venueDishSetupState(undefined, undefined, active, today)).toBe('NEEDS_STATION');
  });
});
