import { describe, expect, it } from 'vitest';
import {
  customerCallAttention,
  deliveryAttention,
  formatWaitDuration,
  waitingSeconds,
} from '../../src/services/operational-exceptions';
import type {
  ClaimedDelivery,
  WaitingCustomerCall,
} from '../../src/services/operational-exceptions';

const now = Date.parse('2026-10-12T18:00:00.000Z');
const call: WaitingCustomerCall = {
  id: 'call',
  table_id: 'table',
  kind: 'WAITER',
  status: 'NEW',
  created_at: '2026-10-12T17:54:00.000Z',
  accepted_at: null,
  assigned_waiter_id: null,
};
const claim: ClaimedDelivery = {
  step_id: 'step',
  waiter_id: 'waiter',
  claimed_at: '2026-10-12T17:49:00.000Z',
  served_at: null,
};

describe('operational exception triage', () => {
  it('marks unaccepted calls over five minutes for manual attention', () => {
    expect(customerCallAttention(call, now)).toBe('DELAYED');
    expect(customerCallAttention({ ...call, created_at: '2026-10-12T17:59:00Z' }, now)).toBe(
      'WAITING',
    );
  });

  it('times accepted calls from their acceptance, not from creation', () => {
    expect(
      customerCallAttention(
        {
          ...call,
          status: 'ACCEPTED',
          accepted_at: '2026-10-12T17:55:00Z',
        },
        now,
      ),
    ).toBe('WAITING');
    expect(
      customerCallAttention(
        {
          ...call,
          status: 'ACCEPTED',
          accepted_at: '2026-10-12T17:49:00Z',
        },
        now,
      ),
    ).toBe('DELAYED');
    expect(customerCallAttention({ ...call, status: 'COMPLETED' }, now)).toBe('NORMAL');
  });

  it('never labels a completed delivery as stranded', () => {
    expect(deliveryAttention(claim, 'READY', now)).toBe('DELAYED');
    expect(deliveryAttention({ ...claim, served_at: '2026-10-12T17:58:00Z' }, 'READY', now)).toBe(
      'NORMAL',
    );
    expect(deliveryAttention({ ...claim, claimed_at: '2026-10-12T17:58:00Z' }, 'READY', now)).toBe(
      'WAITING',
    );
    expect(deliveryAttention(claim, 'SERVED', now)).toBe('DELAYED');
  });

  it('never produces negative durations from clock skew', () => {
    expect(waitingSeconds('2026-10-12T18:01:00Z', now)).toBe(0);
    expect(waitingSeconds('invalid-date', now)).toBe(0);
    expect(formatWaitDuration(0)).toBe('0 s');
    expect(formatWaitDuration(185)).toBe('3 min');
    expect(formatWaitDuration(3661)).toBe('1 h 1 min');
  });
});
