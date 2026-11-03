import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettlementState } from '../../src/services/account-settlement';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function recoveryForEdition(edition: 'CORE' | 'FULL') {
  vi.stubEnv('VITE_PLATEFORM_EDITION', edition);
  vi.resetModules();
  return (await import('../../src/services/account-settlement')).mayResolveManualPayment;
}

describe('account closure depends on authoritative financial state', () => {
  it('permits only a zero remainder with no pending provider/manual payment', () => {
    expect(accountSettlementState('OPEN', { remaining_cents: 0, pending_cents: 0 })).toBe(
      'BALANCED',
    );
    expect(accountSettlementState('OPEN', { remaining_cents: 100, pending_cents: 0 })).toBe(
      'BALANCE_DUE',
    );
    expect(accountSettlementState('OPEN', { remaining_cents: 0, pending_cents: 100 })).toBe(
      'PENDING',
    );
    expect(accountSettlementState('OPEN', { remaining_cents: -1, pending_cents: 0 })).toBe(
      'BALANCE_DUE',
    );
    expect(accountSettlementState('CLOSED', { remaining_cents: 0, pending_cents: 0 })).toBe(
      'CLOSED',
    );
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
  it('allows resuming only pending CORE manual cash/POS payments', async () => {
    const mayResolveManualPayment = await recoveryForEdition('CORE');
    expect(mayResolveManualPayment(payment)).toBe(true);
    expect(mayResolveManualPayment({ ...payment, method: 'CASH' })).toBe(true);
    for (const method of ['STRIPE', 'SATISPAY_API', 'SATISPAY_POS']) {
      expect(mayResolveManualPayment({ ...payment, method })).toBe(false);
    }
  });
  it('allows FULL manual Satispay but never manually confirms an online provider', async () => {
    const mayResolveManualPayment = await recoveryForEdition('FULL');
    expect(mayResolveManualPayment({ ...payment, method: 'SATISPAY_POS' })).toBe(true);
    for (const method of ['STRIPE', 'SATISPAY_API', 'BOGUS']) {
      expect(mayResolveManualPayment({ ...payment, method })).toBe(false);
    }
  });
  it.each(['CORE', 'FULL'] as const)(
    'does not offer a second confirmation on a terminal payment in %s',
    async (edition) => {
      const mayResolveManualPayment = await recoveryForEdition(edition);
      for (const method of ['CASH', 'CARD_POS', 'SATISPAY_POS', 'STRIPE', 'SATISPAY_API']) {
        for (const status of ['COMPLETED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED']) {
          expect(mayResolveManualPayment({ ...payment, method, status })).toBe(false);
        }
      }
    },
  );
});
