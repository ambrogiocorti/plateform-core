import { describe, expect, it } from 'vitest';
import { accountSettlementState } from '../../src/services/account-settlement';
import { mayResolveManualPayment } from '../../src/pages/manual-payment-resolution';

describe('account closure depends on authoritative financial state', () => {
  it('permits only a zero remainder with no pending provider/manual payment', () => {
    expect(accountSettlementState('OPEN', { remaining_cents: 0, pending_cents: 0 }))
      .toBe('BALANCED');
    expect(accountSettlementState('OPEN', { remaining_cents: 100, pending_cents: 0 }))
      .toBe('BALANCE_DUE');
    expect(accountSettlementState('OPEN', { remaining_cents: 0, pending_cents: 100 }))
      .toBe('PENDING');
    expect(accountSettlementState('OPEN', { remaining_cents: -1, pending_cents: 0 }))
      .toBe('BALANCE_DUE');
    expect(accountSettlementState('CLOSED', { remaining_cents: 0, pending_cents: 0 }))
      .toBe('CLOSED');
  });
});

describe('manual pending recovery never creates an additional payment', () => {
  const payment = {
    id: '00000000-0000-4000-8000-000000000001',
    amount_cents: 1200,
    tip_cents: 0,
    register_name: 'Cassa principale',
    method: 'CARD_POS',
    status: 'PENDING',
  };
  it('allows resuming only pending CORE manual cash/POS payments', () => {
    expect(mayResolveManualPayment(payment)).toBe(true);
    expect(mayResolveManualPayment({ ...payment, method: 'CASH' })).toBe(true);
    for (const method of ['STRIPE', 'SATISPAY_API', 'SATISPAY_POS']) {
      expect(mayResolveManualPayment({ ...payment, method })).toBe(false);
    }
  });
  it('does not offer a second confirmation on a terminal payment', () => {
    for (const status of ['COMPLETED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED']) {
      expect(mayResolveManualPayment({ ...payment, status })).toBe(false);
    }
  });
});
