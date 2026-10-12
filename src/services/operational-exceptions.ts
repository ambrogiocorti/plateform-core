/** Operator attention indicators; never assert that an incident was resolved. */
export interface WaitingCustomerCall {
  id: string;
  table_id: string;
  kind: 'WAITER' | 'BILL';
  status: 'NEW' | 'ACCEPTED' | 'COMPLETED';
  created_at: string;
  accepted_at: string | null;
  assigned_waiter_id: string | null;
}

export interface ClaimedDelivery {
  step_id: string;
  waiter_id: string;
  claimed_at: string;
  served_at: string | null;
}

export type AttentionLevel = 'NORMAL' | 'WAITING' | 'DELAYED';

export function waitingSeconds(timestamp: string, now = Date.now()): number {
  const date = Date.parse(timestamp);
  return Number.isFinite(date) ? Math.max(0, Math.floor((now - date) / 1000)) : 0;
}

/** 5 minutes unaccepted / 10 minutes accepted is a visual threshold, not an SLA. */
export function customerCallAttention(
  call: WaitingCustomerCall,
  now = Date.now(),
): AttentionLevel {
  if (call.status === 'COMPLETED') return 'NORMAL';
  const since = call.status === 'ACCEPTED' ? (call.accepted_at ?? call.created_at) : call.created_at;
  const age = waitingSeconds(since, now);
  if (age >= (call.status === 'NEW' ? 5 : 10) * 60) return 'DELAYED';
  return 'WAITING';
}

/** Pickup over 10 min needs an operator check; only the waiter can confirm delivery. */
export function deliveryAttention(
  claim: ClaimedDelivery,
  stepStatus: string | undefined,
  now = Date.now(),
): AttentionLevel {
  if (claim.served_at !== null) return 'NORMAL';
  if (stepStatus && stepStatus !== 'READY') return 'DELAYED';
  return waitingSeconds(claim.claimed_at, now) >= 10 * 60 ? 'DELAYED' : 'WAITING';
}

export function formatWaitDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
