import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  groupWaiterSteps,
  isRunnerOnly,
  sortWaiterTables,
} from '../src/services/waiter-service.ts';

const tables = sortWaiterTables([
  { id: 'available', number: 1, technical_status: 'AVAILABLE' },
  { id: 'service', number: 4, technical_status: 'WAITING_SERVICE' },
  { id: 'bill', number: 8, technical_status: 'WAITING_BILL' },
  { id: 'ordering', number: 2, technical_status: 'ORDERING' },
]);
assert.deepEqual(
  tables.map((table) => table.id),
  ['bill', 'service', 'ordering', 'available'],
  'Waiter tables must put urgent operational states first',
);

assert.equal(
  isRunnerOnly([{ mode: 'RUNNER', active: true }], 0),
  true,
  'Runner-only assignment must activate the simplified delivery workspace',
);
assert.equal(
  isRunnerOnly([{ mode: 'RUNNER', active: true }], 2),
  false,
  'Mixed assignments must preserve the waiter table workspace',
);
assert.equal(
  isRunnerOnly([{ mode: 'RUNNER', active: false }], 0),
  false,
  'Inactive runner assignments must not change the workspace',
);

const steps = groupWaiterSteps([
  {
    id: 'i2',
    order_id: 'o2',
    step_id: 's2',
    step_number: 2,
    step_status: 'READY',
    table_name: 'Tavolo 12',
    table_number: 12,
    dish_name: 'Risotto',
    quantity: 1,
    created_at: '2026-10-05T12:10:00Z',
    can_deliver: true,
  },
  {
    id: 'i1',
    order_id: 'o1',
    step_id: 's1',
    step_number: 1,
    step_status: 'ACTIVE',
    table_name: 'Tavolo 4',
    table_number: 4,
    dish_name: 'Carbonara',
    quantity: 2,
    created_at: '2026-10-05T12:00:00Z',
    can_deliver: false,
  },
  {
    id: 'i3',
    order_id: 'o2',
    step_id: 's2',
    step_number: 2,
    step_status: 'READY',
    table_name: 'Tavolo 12',
    table_number: 12,
    dish_name: 'Filetto',
    quantity: 1,
    created_at: '2026-10-05T12:10:00Z',
    can_deliver: true,
  },
]);
assert.equal(steps.length, 2, 'Kitchen rows must collapse to operational steps');
assert.equal(steps[0]?.id, 's1', 'Older active work must remain visible before newer work');
assert.equal(steps[1]?.items.length, 2, 'Ready step must keep all dishes together');
assert.equal(steps[1]?.canDeliver, true, 'Delivery permission must survive grouping');

const main = fs.readFileSync(new URL('../apps/staff/main.ts', import.meta.url), 'utf8');
const waiter = fs.readFileSync(new URL('../src/pages/waiter.ts', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../styles/staff.css', import.meta.url), 'utf8');

for (const marker of [
  "path: '/servizio'",
  "import('../../src/pages/waiter')",
  "'data-role': profile.role",
])
  assert.ok(main.includes(marker), `Missing staff-shell waiter marker: ${marker}`);

for (const marker of [
  "Promise.all([",
  "'get_floor_workspace'",
  "'get_kitchen_board'",
  "'waiter_calls'",
  "'table_assignments'",
  "button('Nuovo ordine'",
  "button('Prendi in carico'",
  "'transition_waiter_call'",
  "'deliver_step'",
])
  assert.ok(waiter.includes(marker), `Missing operational waiter behavior: ${marker}`);

for (const marker of [
  '.waiter-priority-bar',
  '.waiter-table-grid',
  ".staff-shell[data-role='WAITER'] .workspace",
  '.runner-mode .waiter-delivery-card .waiter-actions',
])
  assert.ok(css.includes(marker), `Missing responsive waiter CSS marker: ${marker}`);

console.log('PASS waiter operational UX gate');
