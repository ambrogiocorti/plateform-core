import { describe, expect, it } from 'vitest';
import { evaluateServicePreflight } from '../../src/services/service-preflight';
import type { ServicePreflightInput } from '../../src/services/service-preflight';

const baseline: ServicePreflightInput = {
  dishes: [{ id: 'dish-a', active: true }],
  venueDishes: [
    { dish_id: 'dish-a', enabled: true, availability: 5, local_station_id: null },
  ],
  dishStations: [{ dish_id: 'dish-a', station_id: 'station-a', is_primary: true }],
  stations: [{ id: 'station-a', active: true }],
  profiles: [
    { id: 'waiter-a', role: 'WAITER', active: true },
    { id: 'kitchen-a', role: 'KITCHEN_STAFF', active: true },
    { id: 'pass-a', role: 'PASS', active: true },
  ],
  venueStaff: [
    { user_id: 'waiter-a', active: true },
    { user_id: 'kitchen-a', active: true },
    { user_id: 'pass-a', active: true },
  ],
  stationStaff: [
    { user_id: 'kitchen-a', station_id: 'station-a', active: true },
  ],
};

describe('per-venue service preflight', () => {
  it('recognizes a correctly assigned waiter, station, pass and sellable dish', () => {
    expect(evaluateServicePreflight(baseline)).toEqual({
      orderableRoutedDishes: 1,
      waiterAssigned: true,
      kitchenStaffed: true,
      passAssigned: true,
    });
  });

  it('rejects zero-stock, disabled dishes, inactive stations and wrong local overrides', () => {
    for (const change of [
      { venueDishes: [{ ...baseline.venueDishes![0]!, availability: 0 }] },
      { venueDishes: [{ ...baseline.venueDishes![0]!, enabled: false }] },
      { dishes: [{ id: 'dish-a', active: false }] },
      { stations: [{ id: 'station-a', active: false }] },
      { venueDishes: [{ ...baseline.venueDishes![0]!, local_station_id: 'inactive-station' }] },
    ]) {
      expect(evaluateServicePreflight({ ...baseline, ...change }).orderableRoutedDishes).toBe(0);
    }
  });

  it('never counts staff from another venue, inactive accounts or unassigned kitchen staff', () => {
    const result = evaluateServicePreflight({
      ...baseline,
      venueStaff: [{ user_id: 'kitchen-a', active: false }],
      stationStaff: [],
    });
    expect(result.waiterAssigned).toBe(false);
    expect(result.kitchenStaffed).toBe(false);
    expect(result.passAssigned).toBe(false);
  });

  it('allows a venue-assigned kitchen admin without station assignment', () => {
    const result = evaluateServicePreflight({
      ...baseline,
      profiles: [{ id: 'chef', role: 'KITCHEN_ADMIN', active: true }],
      venueStaff: [{ user_id: 'chef', active: true }],
      stationStaff: [],
    });
    expect(result.kitchenStaffed).toBe(true);
  });

  it('does not falsely certify global catalog visibility for venue-scoped admin', () => {
    const result = evaluateServicePreflight({
      ...baseline,
      dishes: null,
      venueDishes: null,
      dishStations: null,
    });
    expect(result.orderableRoutedDishes).toBeNull();
  });
});
