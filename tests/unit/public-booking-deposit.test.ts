import { describe, expect, it } from 'vitest';
import {
  depositNotice,
  depositOutcomeView,
  depositReturnId,
  depositTokenKey,
} from '../../src/services/public-booking-contract';
import { permittedBookingSlots } from '../../src/services/commercial-scope';

const id = '11111111-1111-4111-8111-111111111111';
const result = (outcome: Parameters<typeof depositOutcomeView>[0]['outcome']) => ({
  deposit_id: id,
  outcome,
  amount_cents: 2500,
  service_date: '2026-10-22',
  slot_time: '20:00',
  party_size: 8,
});

describe('large-group booking deposit (public page contract)', () => {
  it('explains the guarantee before the request is sent', () => {
    const text = depositNotice({ amount_cents: 2500, expiry_minutes: 45 });
    expect(text).toMatch(/25,00\s€/);
    expect(text).toContain('entro 45 minuti');
    expect(text).toContain('Non è un anticipo sul conto');
    expect(text).toContain('mancata presentazione');
  });

  it('accepts only one well-formed deposit id on return', () => {
    expect(depositReturnId(`?sede=centro&deposito=${id}`)).toBe(id);
    expect(depositReturnId(`?deposito=${id}&deposito=${id}`)).toBeNull();
    expect(depositReturnId('?deposito=../../x')).toBeNull();
    expect(depositReturnId('?payment=ok')).toBeNull();
    expect(depositTokenKey(id)).toBe(`plateform:caparra:${id}`);
  });

  it('only the server outcome CONFIRMED says the table is booked', () => {
    expect(depositOutcomeView(result('CONFIRMED'), id)).toMatchObject({
      title: 'Il tuo tavolo è prenotato.',
      final: true,
    });
    for (const outcome of ['PENDING', 'FAILED', 'EXPIRED', 'RECONCILIATION_REQUIRED'] as const)
      expect(depositOutcomeView(result(outcome), id).title).not.toContain('prenotato');
    expect(depositOutcomeView(result('PENDING'), id).final).toBe(false);
    expect(() => depositOutcomeView(result('CONFIRMED'), 'other')).toThrow(
      'INVALID_DEPOSIT_CONTEXT',
    );
  });

  it('offers deposit slots only with their terms and keeps small groups unchanged', () => {
    const deposit = { amount_cents: 2500, currency: 'EUR', expiry_minutes: 45 };
    expect(
      permittedBookingSlots([
        { status_if_booked: 'RESERVED' },
        { status_if_booked: 'PENDING_DEPOSIT', deposit },
        { status_if_booked: 'PENDING_DEPOSIT' },
        { status_if_booked: 'RESERVED', deposit },
      ]),
    ).toEqual([{ status_if_booked: 'RESERVED' }, { status_if_booked: 'PENDING_DEPOSIT', deposit }]);
  });
});
