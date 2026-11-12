import {
  waitlistAcceptResult,
  waitlistCreateResult,
  waitlistRequestSchema,
} from '../_shared/waitlist.ts';

function assert(value: unknown): asserts value {
  if (!value) throw new Error('Waitlist validation failed');
}

const id = '00000000-0000-4000-8000-000000000001';
const create = {
  action: 'CREATE',
  venue_id: id,
  service_id: id,
  date: '2026-11-01',
  preferred_start: '19:00',
  preferred_end: null,
  party_size: 2,
  customer_name: 'Maria Rossi',
  customer_phone: '+393331234567',
  notes: null,
  idempotency_key: id,
};

Deno.test('waitlist public registration validates only explicit fields and sane values', () => {
  assert(waitlistRequestSchema.safeParse(create).success);
  for (const changed of [
    { ...create, party_size: 0 },
    { ...create, date: '2026-99-99' },
    { ...create, customer_phone: '3331234567' },
    { ...create, preferred_start: '37:00' },
    { ...create, customer_name: ' ' },
    { ...create, service_id: 'other' },
    { ...create, role: 'service_role' },
  ])
    assert(!waitlistRequestSchema.safeParse(changed).success);
  assert(
    waitlistCreateResult.safeParse({
      id,
      status: 'WAITING',
      service_date: '2026-11-01',
      preferred_start_time: '19:00:00',
      preferred_end_time: null,
    }).success,
  );
});

Deno.test('waitlist offer redemption requires a valid opaque token and request key', () => {
  const request = {
    action: 'ACCEPT',
    entry_id: id,
    access_token: 'a'.repeat(64),
    idempotency_key: id,
  };
  assert(waitlistRequestSchema.safeParse(request).success);
  for (const changed of [
    { ...request, access_token: 'short' },
    { ...request, access_token: 'X'.repeat(64) },
    { ...request, idempotency_key: null },
    { ...request, venue_id: id },
  ])
    assert(!waitlistRequestSchema.safeParse(changed).success);
  assert(
    waitlistAcceptResult.safeParse({
      entry_id: id,
      status: 'CONVERTED_TO_RESERVATION',
      reservation_id: id,
      reservation_status: 'RESERVED',
      offered_time: '19:00:00',
      deposit: null,
    }).success,
  );
  assert(
    !waitlistAcceptResult.safeParse({
      entry_id: id,
      status: 'CONVERTED_TO_RESERVATION',
      reservation_id: id,
      reservation_status: 'WAITING',
      offered_time: '19:00:00',
      deposit: null,
    }).success,
  );
});
