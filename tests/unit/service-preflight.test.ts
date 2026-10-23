import { describe, expect, it } from 'vitest';
import { evaluateServicePreflight } from '../../src/services/service-preflight';
import type { ServicePreflightInput } from '../../src/services/service-preflight';

const baseline: ServicePreflightInput = {
  dishes: [
    {
      id: 'dish-a',
      category_id: 'category-a',
      active: true,
      schedule_mode: 'ALWAYS',
      available_from: null,
      available_until: null,
      weekdays: null,
    },
  ],
  categories: [{ id: 'category-a', active: true }],
  localDate: '2026-10-12',
  venueDishes: [
    {
      dish_id: 'dish-a',
      enabled: true,
      availability: 5,
      availability_date: '2026-10-12',
      local_station_id: null,
    },
  ],
  dishStations: [{ dish_id: 'dish-a', station_id: 'station-a', is_primary: true }],
  stations: [{ id: 'station-a', active: true }],
  profiles: [
    { id: 'waiter-a', role: 'WAITER', active: true },
    { id: 'kitchen-a', role: 'KITCHEN_STAFF', active: true },
    { id: 'pass-a', role: 'PASS', active: true },
    { id: 'cashier-a', role: 'CASHIER', active: true },
  ],
  venueStaff: [
    { user_id: 'waiter-a', active: true },
    { user_id: 'kitchen-a', active: true },
    { user_id: 'pass-a', active: true },
    { user_id: 'cashier-a', active: true },
  ],
  stationStaff: [{ user_id: 'kitchen-a', station_id: 'station-a', active: true }],
  cashRegisters: [{ id: 'cash-register-a', active: true }],
  cashiers: [{ user_id: 'cashier-a', cash_register_id: 'cash-register-a', active: true }],
};

describe('per-venue service preflight', () => {
  it('recognizes a correctly assigned waiter, station, pass and sellable dish', () => {
    expect(evaluateServicePreflight(baseline)).toEqual({
      orderableRoutedDishes: 1,
      waiterAssigned: true,
      kitchenStaffed: true,
      passAssigned: true,
      cashierAssigned: true,
    });
  });

  it('rejects zero-stock, disabled dishes, inactive stations and wrong local overrides', () => {
    for (const change of [
      { venueDishes: [{ ...baseline.venueDishes![0]!, availability: 0 }] },
      { venueDishes: [{ ...baseline.venueDishes![0]!, enabled: false }] },
      { dishes: [{ ...baseline.dishes![0]!, active: false }] },
      { categories: [{ id: 'category-a', active: false }] },
      { venueDishes: [{ ...baseline.venueDishes![0]!, availability_date: '2026-10-11' }] },
      { stations: [{ id: 'station-a', active: false }] },
      { venueDishes: [{ ...baseline.venueDishes![0]!, local_station_id: 'inactive-station' }] },
    ]) {
      expect(evaluateServicePreflight({ ...baseline, ...change }).orderableRoutedDishes).toBe(0);
    }
  });

  it('accepts a missing per-venue override as enabled, but not an inactive category', () => {
    expect(evaluateServicePreflight({ ...baseline, venueDishes: [] }).orderableRoutedDishes).toBe(
      1,
    );
    expect(
      evaluateServicePreflight({
        ...baseline,
        categories: [{ id: 'category-a', active: false }],
      }).orderableRoutedDishes,
    ).toBe(0);
  });

  it('honors local calendar availability, weekly schedules and station overrides', () => {
    const weekdayDish = {
      ...baseline.dishes![0]!,
      schedule_mode: 'WEEKDAYS',
      weekdays: [1],
    };
    expect(
      evaluateServicePreflight({
        ...baseline,
        dishes: [weekdayDish],
        venueDishes: [{ ...baseline.venueDishes![0]!, availability: null }],
      }).orderableRoutedDishes,
    ).toBe(1);
    expect(
      evaluateServicePreflight({
        ...baseline,
        localDate: '2026-10-13',
        dishes: [weekdayDish],
      }).orderableRoutedDishes,
    ).toBe(0);
    expect(
      evaluateServicePreflight({
        ...baseline,
        venueDishes: [{ ...baseline.venueDishes![0]!, local_station_id: 'inactive' }],
      }).orderableRoutedDishes,
    ).toBe(0);
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
    expect(result.cashierAssigned).toBe(false);
  });

  it('requires an active cashier and a valid register assignment', () => {
    for (const changes of [
      { cashRegisters: [{ id: 'cash-register-a', active: false }] },
      { cashiers: [{ user_id: 'cashier-a', cash_register_id: 'other', active: true }] },
      { cashiers: [{ user_id: 'cashier-a', cash_register_id: 'cash-register-a', active: false }] },
    ]) {
      expect(evaluateServicePreflight({ ...baseline, ...changes }).cashierAssigned).toBe(false);
    }
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
      categories: null,
      venueDishes: null,
      dishStations: null,
    });
    expect(result.orderableRoutedDishes).toBeNull();
  });
});
