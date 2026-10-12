/** Presentation only. The server's close_account(...) remains authoritative. */
export interface SettlementBalance {
  remaining_cents: number;
  pending_cents: number;
}

export type AccountSettlementState =
  | 'CLOSED'
  | 'PENDING'
  | 'BALANCE_DUE'
  | 'BALANCED';

export function accountSettlementState(
  accountStatus: string,
  balance: SettlementBalance,
): AccountSettlementState {
  if (accountStatus === 'CLOSED') return 'CLOSED';
  if (balance.pending_cents !== 0) return 'PENDING';
  if (balance.remaining_cents !== 0) return 'BALANCE_DUE';
  return 'BALANCED';
}
