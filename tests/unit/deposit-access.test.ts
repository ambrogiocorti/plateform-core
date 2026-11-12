import { describe, expect, it } from 'vitest';
import { pendingDepositAccess, rememberDepositAccess } from '../../src/services/deposit-access';

const access = {
  deposit: '10000000-0000-4000-8000-000000000001',
  venue: '10000000-0000-4000-8000-000000000002',
  token: 'a'.repeat(64),
};
function store() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}
describe('tab-local deposit return capability', () => {
  it('recovers the capability only for the same deposit and venue', () => {
    const session = store();
    expect(rememberDepositAccess(session, access, 1000)).toBe(true);
    expect(pendingDepositAccess(session, access.deposit, access.venue, 2000)).toEqual(access);
    expect(pendingDepositAccess(session, access.deposit, access.deposit, 2000)).toBeNull();
    expect(session.data.size).toBe(0);
  });
  it('expires and removes the guest capability after 24 hours', () => {
    const session = store();
    rememberDepositAccess(session, access, 1000);
    expect(
      pendingDepositAccess(session, access.deposit, access.venue, 1000 + 24 * 3600 * 1000),
    ).toBeNull();
    expect(session.data.size).toBe(0);
  });
  it('rejects a forged future save time and malformed persisted records', () => {
    const session = store();
    rememberDepositAccess(session, access, 5000);
    expect(pendingDepositAccess(session, access.deposit, access.venue, 1000)).toBeNull();
    session.setItem(`plateform-deposit:${access.deposit}`, '{broken');
    expect(pendingDepositAccess(session, access.deposit, access.venue)).toBeNull();
  });
  it('does not save malformed tokens, identifiers or an unavailable storage backend', () => {
    const session = store();
    expect(rememberDepositAccess(session, { ...access, token: 'short' })).toBe(false);
    expect(rememberDepositAccess(session, { ...access, deposit: '../other' })).toBe(false);
    expect(
      rememberDepositAccess(
        {
          ...session,
          setItem: () => {
            throw new Error('Storage blocked');
          },
        },
        access,
      ),
    ).toBe(false);
  });
});
