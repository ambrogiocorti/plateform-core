import assert from 'node:assert/strict';
import {
  accountSettlementState,
  mayResolveManualPayment,
} from '../src/services/account-settlement.ts';
import { evaluateSetup, setupDefinitions } from '../src/services/setup-readiness.ts';
import { evaluateServicePreflight } from '../src/services/service-preflight.ts';
import { venueDishSetupState } from '../src/services/venue-menu-status.ts';
import {
  menuEngineeringCostAt,
  validMenuEngineeringPeriod,
} from '../src/services/menu-engineering.ts';
import {
  customerCallAttention,
  deliveryAttention,
} from '../src/services/operational-exceptions.ts';
import { waiterDeliveryAction } from '../src/services/waiter-service.ts';

// Dependency-free behavioral checks against actual application modules.
// These verify presentation decisions, not PostgREST authorization or a live service.
let count = 0;
function check(label, run) {
  run();
  count += 1;
  console.log(`PASS ${label}`);
}

const facts = Object.fromEntries(setupDefinitions.map((step) => [step.key, true]));
check('empty configuration starts with rooms', () => {
  const empty = Object.fromEntries(setupDefinitions.map((step) => [step.key, false]));
  assert.equal(evaluateSetup(empty).next.key, 'rooms');
  assert.equal(evaluateSetup(empty).basicsConfigured, false);
});
check('chain-managed catalog is never counted as completed', () => {
  const result = evaluateSetup({ ...facts, dishes: 'MANAGED_BY_CHAIN' });
  assert.equal(result.basicsConfigured, false);
  assert.equal(result.next.requiresChain, true);
});

const baseline = {
  localDate: '2026-10-16',
  dishes: [
    {
      id: 'dish',
      category_id: 'category',
      active: true,
      schedule_mode: 'ALWAYS',
      available_from: null,
      available_until: null,
      weekdays: null,
    },
  ],
  categories: [{ id: 'category', active: true }],
  venueDishes: [
    {
      dish_id: 'dish',
      enabled: true,
      availability: 1,
      availability_date: '2026-10-16',
      local_station_id: null,
    },
  ],
  dishStations: [{ dish_id: 'dish', station_id: 'station', is_primary: true }],
  stations: [{ id: 'station', active: true }],
  profiles: [{ id: 'waiter', active: true, role: 'WAITER' }],
  venueStaff: [{ user_id: 'waiter', active: true }],
  stationStaff: [],
  cashRegisters: [],
  cashiers: [],
};
check('today last portion with active routing is orderable', () => {
  assert.equal(evaluateServicePreflight(baseline).orderableRoutedDishes, 1);
});
for (const [label, changes] of [
  ['sold-out dish', { venueDishes: [{ ...baseline.venueDishes[0], availability: 0 }] }],
  [
    'yesterday stock',
    { venueDishes: [{ ...baseline.venueDishes[0], availability_date: '2026-10-15' }] },
  ],
  ['inactive station', { stations: [{ id: 'station', active: false }] }],
  [
    'invalid local override',
    { venueDishes: [{ ...baseline.venueDishes[0], local_station_id: 'other' }] },
  ],
  ['inactive category', { categories: [{ id: 'category', active: false }] }],
])
  check(`${label} cannot appear ready`, () => {
    assert.equal(evaluateServicePreflight({ ...baseline, ...changes }).orderableRoutedDishes, 0);
  });
check('another venue staff cannot satisfy readiness', () => {
  assert.equal(evaluateServicePreflight({ ...baseline, venueStaff: [] }).waiterAssigned, false);
});
check('unavailable catalog stays unverified', () => {
  assert.equal(evaluateServicePreflight({ ...baseline, dishes: null }).orderableRoutedDishes, null);
});
check('local station override cannot fall back to another active station', () => {
  assert.equal(
    venueDishSetupState(
      { ...baseline.venueDishes[0], local_station_id: 'other' },
      'station',
      new Set(['station']),
      baseline.localDate,
    ),
    'NEEDS_STATION',
  );
});
for (const [balance, expected] of [
  [{ remaining_cents: 0, pending_cents: 0 }, 'BALANCED'],
  [{ remaining_cents: 0, pending_cents: 1 }, 'PENDING'],
  [{ remaining_cents: 1, pending_cents: 0 }, 'BALANCE_DUE'],
  [{ remaining_cents: -1, pending_cents: 0 }, 'BALANCE_DUE'],
])
  check(`account settlement ${expected}`, () => {
    assert.equal(accountSettlementState('OPEN', balance), expected);
  });
for (const method of ['CASH', 'CARD_POS', 'STRIPE', 'SATISPAY_API', 'SATISPAY_POS']) {
  check(`manual recovery respects ${method} product boundary`, () => {
    assert.equal(
      mayResolveManualPayment({ method, status: 'PENDING' }),
      // Satispay at the counter is confirmed by the operator like an external POS.
      ['CASH', 'CARD_POS', 'SATISPAY_POS'].includes(method),
    );
    assert.equal(mayResolveManualPayment({ method, status: 'COMPLETED' }), false);
  });
}
check('historical food-cost detail uses the same period through DST changes', () => {
  for (const date of ['2026-03-29', '2026-10-25']) {
    assert.equal(menuEngineeringCostAt(date, 'Europe/Rome'), `${date} 23:59:59.999999 Europe/Rome`);
  }
  assert.throws(() => menuEngineeringCostAt('2026-02-30', 'Europe/Rome'));
  assert.throws(() => menuEngineeringCostAt('2026-10-16', 'Invalid/Timezone'));
  assert.equal(validMenuEngineeringPeriod('2026-10-16', '2026-10-15'), false);
});
check('late calls and claimed deliveries require operator attention', () => {
  const created = '2026-10-16T10:00:00Z';
  const now = Date.parse('2026-10-16T10:11:00Z');
  assert.equal(
    customerCallAttention({ status: 'NEW', created_at: created, accepted_at: null }, now),
    'DELAYED',
  );
  assert.equal(
    deliveryAttention({ claimed_at: created, served_at: null }, 'READY', now),
    'DELAYED',
  );
});
check('only an owned delivery claim offers SERVED confirmation', () => {
  const ready = { id: 'step', status: 'READY', canDeliver: true };
  assert.equal(waiterDeliveryAction(ready, new Set()), 'CLAIM');
  assert.equal(waiterDeliveryAction(ready, new Set(['step'])), 'CONFIRM_SERVED');
  assert.equal(waiterDeliveryAction({ ...ready, canDeliver: false }, new Set(['step'])), 'NONE');
});
console.log(`OPERATIONAL_READINESS_BEHAVIOR=PASS (${count}/${count})`);
