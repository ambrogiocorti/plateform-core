import { z } from 'zod';

const aggregate = z.object({ amount_cents: z.number().int(), tip_cents: z.number().int() });
const counts = z.object({ reservations: z.number().int(), covers: z.number().int() });
const products = z.object({
  name: z.string(),
  quantity: z.number().int(),
  amount_cents: z.number().int(),
});
const basicStatistics = z.object({
  receipts_cents: z.number().int(),
  refunds_cents: z.number().int(),
  reversals_cents: z.number().int(),
  net_cents: z.number().int(),
  tips_cents: z.number().int(),
  covers: z.number().int(),
  reservations: z.number().int(),
  preparation_seconds: z.number().nullable(),
  daily: z.array(aggregate.extend({ local_date: z.string() })),
  methods: z.array(aggregate.extend({ method: z.string(), entries: z.number().int() })),
  venues: z.array(aggregate.extend({ id: z.uuid(), name: z.string() })),
  products: z.array(products),
  categories: z.array(products),
  closed_accounts: z.number().int(),
  average_check_cents: z.number().int().nullable(),
  no_shows: z.number().int(),
  no_show_percent: z.number().nullable(),
  cancelled_reservations: z.number().int(),
  walk_ins: z.number().int(),
  booking_states: z.array(counts.extend({ status: z.string() })),
  booking_slots: z.array(counts.extend({ slot_time: z.string() })),
  returns: z.number().int(),
  calls: z.number().int(),
  call_acceptance_seconds: z.number().nullable(),
  call_completion_seconds: z.number().nullable(),
  stations: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      items: z.number().int(),
      preparation_seconds: z.number().nullable(),
      delivery_seconds: z.number().nullable(),
    }),
  ),
  registers: z.array(aggregate.extend({ id: z.uuid(), name: z.string() })),
  services: z.array(aggregate.extend({ name: z.string() })),
});

const advancedStatistics = basicStatistics.extend({
  advanced: z.literal(true),
  average_stay_seconds: z.number().nullable(),
  cancelled_items: z.number().int(),
  operational_errors: z.number().int(),
  incidents: z.number().int(),
  open_incidents: z.number().int(),
  capacity_services: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      capacity_covers: z.number().int().nullable(),
      used_covers: z.number().int(),
      utilization_percent: z.number().nullable(),
    }),
  ),
});

// Old installations returned the advanced payload before adding the explicit
// discriminator. A basic response never invents zero-valued advanced metrics.
export const statisticsSchema = z.preprocess(
  (value) =>
    value && typeof value === 'object' && !Array.isArray(value) && !Object.hasOwn(value, 'advanced')
      ? { ...value, advanced: true }
      : value,
  z.discriminatedUnion('advanced', [
    basicStatistics.extend({ advanced: z.literal(false) }),
    advancedStatistics,
  ]),
);
