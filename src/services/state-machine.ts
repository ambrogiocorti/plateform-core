export type TransitionMap = Readonly<Record<string, readonly string[]>>;

export const stateMachines = {
  installation: {
    ACTIVE: ['SUSPENDED'],
    SUSPENDED: ['ACTIVE', 'PENDING_DELETION'],
    PENDING_DELETION: ['SUSPENDED', 'ARCHIVED'],
    ARCHIVED: ['PERMANENTLY_DELETED'],
    PERMANENTLY_DELETED: [],
  },
  reservation: {
    REQUESTED: ['RESERVED', 'CANCELLED'],
    RESERVED: ['ARRIVED', 'NO_SHOW', 'CANCELLED'],
    ARRIVED: ['SEATED', 'CANCELLED'],
    SEATED: ['COMPLETED'],
    COMPLETED: [],
    NO_SHOW: [],
    CANCELLED: [],
  },
  table: {
    AVAILABLE: ['RESERVED', 'OCCUPIED'],
    RESERVED: ['ARRIVING', 'AVAILABLE', 'OCCUPIED'],
    ARRIVING: ['OCCUPIED', 'AVAILABLE'],
    OCCUPIED: ['ORDERING', 'WAITING_SERVICE', 'WAITING_BILL'],
    ORDERING: ['WAITING_SERVICE', 'WAITING_BILL'],
    WAITING_SERVICE: ['ORDERING', 'WAITING_BILL'],
    WAITING_BILL: ['PAYMENT', 'ORDERING'],
    PAYMENT: ['TO_RESET'],
    TO_RESET: ['AVAILABLE'],
  },
  account: {
    OPEN: ['BILL_REQUESTED', 'AT_CASHIER'],
    BILL_REQUESTED: ['OPEN', 'AT_CASHIER'],
    AT_CASHIER: ['PARTIALLY_PAID', 'PAID'],
    PARTIALLY_PAID: ['PAID'],
    PAID: ['CLOSED'],
    CLOSED: [],
  },
  order: {
    RECEIVED: ['IN_PREPARATION', 'CANCELLED'],
    IN_PREPARATION: ['READY', 'CANCELLED'],
    READY: ['SERVED', 'CANCELLED'],
    SERVED: [],
    CANCELLED: [],
  },
  step: {
    WAITING: ['ACTIVE', 'CANCELLED'],
    ACTIVE: ['READY', 'CANCELLED'],
    READY: ['SERVED', 'CANCELLED'],
    SERVED: [],
    CANCELLED: [],
  },
  call: { NEW: ['ACCEPTED'], ACCEPTED: ['COMPLETED'], COMPLETED: [] },
  payment: {
    PENDING: ['COMPLETED', 'FAILED', 'CANCELLED'],
    COMPLETED: ['PARTIALLY_REFUNDED', 'REFUNDED', 'CANCELLED'],
    PARTIALLY_REFUNDED: ['REFUNDED'],
    REFUNDED: [],
    FAILED: [],
    CANCELLED: [],
  },
  refund: {
    REQUESTED: ['APPROVED', 'REJECTED'],
    APPROVED: ['PENDING', 'COMPLETED'],
    PENDING: ['COMPLETED', 'FAILED'],
    FAILED: ['PENDING'],
    COMPLETED: [],
    REJECTED: [],
  },
  register: { CLOSED: ['OPEN'], OPEN: ['CLOSED'] },
  service: {
    OPEN: ['RECONCILING'],
    RECONCILING: ['AWAITING_APPROVAL', 'CLOSED'],
    AWAITING_APPROVAL: ['CLOSED'],
    CLOSED: [],
  },
  print: {
    QUEUED: ['SENT', 'CANCELLED'],
    SENT: ['SUCCESS', 'FAILED'],
    SUCCESS: [],
    FAILED: ['QUEUED', 'CANCELLED'],
    CANCELLED: [],
  },
  backup: { QUEUED: ['RUNNING'], RUNNING: ['SUCCEEDED', 'FAILED'], SUCCEEDED: [], FAILED: [] },
  restore: {
    REQUESTED: ['CONFIRMED'],
    CONFIRMED: ['SNAPSHOTTING'],
    SNAPSHOTTING: ['RESTORING', 'FAILED'],
    RESTORING: ['VERIFYING', 'FAILED'],
    VERIFYING: ['SUCCEEDED', 'FAILED'],
    SUCCEEDED: [],
    FAILED: [],
  },
  notification: {
    NEW: ['ACKNOWLEDGED', 'EXPIRED'],
    ACKNOWLEDGED: ['RESOLVED', 'EXPIRED'],
    RESOLVED: [],
    EXPIRED: [],
  },
} as const satisfies Record<string, TransitionMap>;

// UI guidance only: server commands perform their own role, resource and state checks.
export function canTransition(machine: TransitionMap, from: string, to: string): boolean {
  return machine[from]?.includes(to) ?? false;
}
